import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESOURCE_LIMITS, MAX_RENDER_MEMORY_BYTES, MEBIBYTE, UNKNOWN_DEVICE_MEMORY_BYTES,
  detectDeviceResources, normalizeResourceLimits, planResources, type DeviceResources, type ResourceLimits,
} from './resource-budget';

const settings = { width: 1280, height: 720 };
const device: DeviceResources = { logicalCores: 12, deviceMemoryGiB: 8, gpuAvailable: true };
const limits = (overrides: Partial<ResourceLimits> = {}): ResourceLimits => ({ ...DEFAULT_RESOURCE_LIMITS, ...overrides });

describe('per-device renderer resource budgets', () => {
  it('normalizes browser hints without presenting missing RAM as a measured capacity', () => {
    expect(detectDeviceResources({})).toEqual({ logicalCores: 2, deviceMemoryGiB: null, gpuAvailable: false });
    expect(detectDeviceResources({ hardwareConcurrency: 12, deviceMemory: 8, gpu: {} })).toEqual(device);
    expect(detectDeviceResources({ hardwareConcurrency: -8, deviceMemory: Number.NaN })).toEqual({ logicalCores: 2, deviceMemoryGiB: null, gpuAvailable: false });
    expect(detectDeviceResources({ hardwareConcurrency: Infinity, deviceMemory: 0 }).deviceMemoryGiB).toBeNull();
    expect(detectDeviceResources({ hardwareConcurrency: 9999 }).logicalCores).toBe(128);
  });

  it('sanitizes persisted user settings and starts with GPU opt-in', () => {
    expect(normalizeResourceLimits(null)).toEqual({ cpuPercent: 25, gpuPercent: 0, ramPercent: 10 });
    expect(normalizeResourceLimits({ cpuPercent: -3, gpuPercent: 101, ramPercent: Number.NaN })).toEqual({ cpuPercent: 0, gpuPercent: 100, ramPercent: 10 });
  });

  it('sets worker count and duty to logical-core capacity, including fractional values', () => {
    expect(planResources(settings, limits(), device)).toMatchObject({ cpuWorkers: 3, cpuDutyCycle: 1, gpuEnabled: false, canRender: true });
    const fractional = planResources(settings, limits({ cpuPercent: 5 }), device);
    expect(fractional.cpuWorkers).toBe(1);
    expect(fractional.cpuDutyCycle).toBeCloseTo(0.6);
    const tiny = planResources(settings, limits({ cpuPercent: 1 }), { ...device, logicalCores: 1 });
    expect(tiny.cpuWorkers).toBe(1);
    expect(tiny.cpuDutyCycle).toBe(0.01);
  });

  it('bounds concurrency for many-core machines and very short images', () => {
    const large = { ...device, logicalCores: 128 };
    expect(planResources(settings, limits({ cpuPercent: 100 }), large).cpuWorkers).toBe(16);
    expect(planResources({ width: 64, height: 3 }, limits({ cpuPercent: 100 }), large).cpuWorkers).toBe(1);
    expect(planResources(settings, limits({ cpuPercent: 100 }), { ...device, logicalCores: 1 }).cpuWorkers).toBe(1);
  });

  it('never plans CPU work above the requested core-equivalent upper bound', () => {
    let priorCapacity = 0;
    for (let cpuPercent = 0; cpuPercent <= 100; cpuPercent += 1) {
      const plan = planResources(settings, limits({ cpuPercent }), device);
      const capacity = plan.cpuWorkers * plan.cpuDutyCycle;
      expect(capacity).toBeLessThanOrEqual(device.logicalCores * cpuPercent / 100 + 1e-12);
      expect(capacity).toBeGreaterThanOrEqual(priorCapacity);
      expect(plan.plannedBytes).toBeLessThanOrEqual(plan.ramBudgetBytes);
      priorCapacity = capacity;
    }
  });

  it('honors zero CPU/GPU and supports a real GPU-only plan when available', () => {
    const off = planResources(settings, limits({ cpuPercent: 0 }), device);
    expect(off).toMatchObject({ cpuWorkers: 0, cpuDutyCycle: 0, gpuEnabled: false, canRender: false });
    const gpuOnly = planResources(settings, limits({ cpuPercent: 0, gpuPercent: 35 }), device);
    expect(gpuOnly).toMatchObject({ cpuWorkers: 0, gpuEnabled: true, gpuDutyCycle: 0.35, canRender: true });
    const unavailable = planResources(settings, limits({ cpuPercent: 0, gpuPercent: 35 }), { ...device, gpuAvailable: false });
    expect(unavailable.canRender).toBe(false);
    expect(unavailable.reason).toContain('GPU');
  });

  it('treats RAM as an allocation ceiling, never as space to fill unnecessarily', () => {
    const low = planResources(settings, limits({ ramPercent: 10 }), device);
    const high = planResources(settings, limits({ ramPercent: 100 }), device);
    expect(low.ramBudgetBytes).toBe(MAX_RENDER_MEMORY_BYTES);
    expect(high.ramBudgetBytes).toBe(MAX_RENDER_MEMORY_BYTES);
    expect(low.plannedBytes).toBe(high.plannedBytes);
    expect(low.plannedBytes).toBeLessThan(100 * MEBIBYTE);
    expect(low.plannedBytes).toBeGreaterThan(low.frameBytes * 3);
    expect(planResources(settings, limits({ gpuPercent: 50 }), device).plannedBytes).toBeGreaterThan(low.plannedBytes);
  });

  it('uses conservative unknown-memory fallback and reduces concurrency to fit the budget', () => {
    const unknown = { ...device, logicalCores: 128, deviceMemoryGiB: null };
    const plan = planResources(settings, limits({ cpuPercent: 100 }), unknown);
    expect(plan.ramBudgetBytes).toBe(Math.floor(UNKNOWN_DEVICE_MEMORY_BYTES * 0.1));
    expect(plan.cpuWorkers).toBeLessThan(16);
    expect(plan.plannedBytes).toBeLessThanOrEqual(plan.ramBudgetBytes);
    expect(plan.canRender).toBe(true);
  });

  it('rejects rendering when RAM cannot hold output and minimum worker buffers', () => {
    for (const ramPercent of [0, 1]) {
      const plan = planResources(settings, limits({ ramPercent }), { ...device, deviceMemoryGiB: null });
      expect(plan.canRender).toBe(false);
      expect(plan.cpuWorkers).toBe(0);
      expect(plan.reason).toContain('RAM');
    }
    const gpu = planResources(settings, limits({ ramPercent: 0, gpuPercent: 50 }), device);
    expect(gpu.gpuEnabled).toBe(false);
    expect(gpu.gpuDutyCycle).toBe(0);
  });
});
