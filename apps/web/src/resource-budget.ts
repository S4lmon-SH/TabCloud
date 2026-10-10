import type { AnimationSettings } from '@tabcloud/shared';

export interface ResourceLimits { cpuPercent: number; gpuPercent: number; ramPercent: number }
export interface DeviceResources { logicalCores: number; deviceMemoryGiB: number | null; gpuAvailable: boolean }
export interface ResourcePlan {
  cpuWorkers: number;
  cpuDutyCycle: number;
  gpuEnabled: boolean;
  gpuDutyCycle: number;
  ramBudgetBytes: number;
  plannedBytes: number;
  frameBytes: number;
  chunkRows: number;
  maxCpuWorkers: number;
  canRender: boolean;
  reason: string | null;
}

export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({ cpuPercent: 25, gpuPercent: 0, ramPercent: 10 });
export const MEBIBYTE = 1024 * 1024;
export const MAX_RENDER_MEMORY_BYTES = 512 * MEBIBYTE;
export const UNKNOWN_DEVICE_MEMORY_BYTES = 512 * MEBIBYTE;
const MAX_CPU_WORKERS = 16;
// Reserve headroom for each Worker's scene, messages and runtime; this is not a heap measurement.
const CPU_WORKER_ALLOWANCE_BYTES = 8 * MEBIBYTE;
const FIXED_ALLOWANCE_BYTES = 64 * 1024;

function percent(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : fallback;
}

export function normalizeResourceLimits(value?: Partial<ResourceLimits> | null): ResourceLimits {
  return {
    cpuPercent: percent(value?.cpuPercent, DEFAULT_RESOURCE_LIMITS.cpuPercent),
    gpuPercent: percent(value?.gpuPercent, DEFAULT_RESOURCE_LIMITS.gpuPercent),
    ramPercent: percent(value?.ramPercent, DEFAULT_RESOURCE_LIMITS.ramPercent),
  };
}

interface NavigatorResources { hardwareConcurrency?: number; deviceMemory?: number; gpu?: unknown }

/** Browser hints are coarse, may be privacy-reduced, and do not measure free RAM or OS utilization. */
export function detectDeviceResources(source?: NavigatorResources): DeviceResources {
  const hints: NavigatorResources = source ?? (typeof navigator === 'undefined' ? {} : navigator);
  const cores = hints.hardwareConcurrency;
  const memory = hints.deviceMemory;
  return {
    logicalCores: typeof cores === 'number' && Number.isFinite(cores) && cores >= 1 ? Math.min(128, Math.floor(cores)) : 2,
    deviceMemoryGiB: typeof memory === 'number' && Number.isFinite(memory) && memory > 0 ? Math.min(128, memory) : null,
    // Adapter acquisition may still fail. The caller replaces this with the actual probe result.
    gpuAvailable: hints.gpu != null,
  };
}

/**
 * Upper bounds for renderer concurrency and buffers, not promises of device-wide percentages.
 * More RAM permits more concurrent work; the application never allocates dummy data to fill it.
 * CPU capacity is logical-core equivalents: N Workers × dutyCycle <= cores × percentage.
 */
export function planResources(settings: Pick<AnimationSettings, 'width' | 'height'>,
  input: ResourceLimits, hints: DeviceResources): ResourcePlan {
  const limits = normalizeResourceLimits(input);
  const device = detectDeviceResources({ hardwareConcurrency: hints.logicalCores, deviceMemory: hints.deviceMemoryGiB ?? undefined });
  if (!Number.isInteger(settings.width) || !Number.isInteger(settings.height)
    || settings.width < 1 || settings.width > 1280 || settings.height < 1 || settings.height > 720) {
    throw new RangeError('Unsupported render buffer dimensions.');
  }
  const deviceMemoryBytes = device.deviceMemoryGiB === null ? UNKNOWN_DEVICE_MEMORY_BYTES : device.deviceMemoryGiB * 1024 ** 3;
  const ramBudgetBytes = Math.floor(Math.min(MAX_RENDER_MEMORY_BYTES, deviceMemoryBytes * limits.ramPercent / 100));
  const frameBytes = settings.width * settings.height * 4;
  const chunkRows = Math.min(8, settings.height);
  const chunkPixels = settings.width * chunkRows;
  const coreCapacity = device.logicalCores * limits.cpuPercent / 100;
  const maxCpuWorkers = Math.min(MAX_CPU_WORKERS, device.logicalCores, Math.ceil(settings.height / chunkRows), Math.ceil(coreCapacity));
  const gpuEnabled = hints.gpuAvailable && limits.gpuPercent > 0;
  // Full output + upload copy + preview headroom, plus one bounded GPU dispatch at a time.
  const fixedBytes = frameBytes * 3 + FIXED_ALLOWANCE_BYTES + (gpuEnabled ? chunkPixels * 32 + 1024 : 0);
  // Compact Worker output and its transport/merge overlap are both reserved.
  const cpuWorkerBytes = CPU_WORKER_ALLOWANCE_BYTES + chunkPixels * 8;
  const cpuWorkers = Math.min(maxCpuWorkers, Math.max(0, Math.floor((ramBudgetBytes - fixedBytes) / cpuWorkerBytes)));
  const plannedBytes = fixedBytes + cpuWorkers * cpuWorkerBytes;
  const fitsMemory = ramBudgetBytes > 0 && plannedBytes <= ramBudgetBytes;
  const canRender = fitsMemory && (cpuWorkers > 0 || gpuEnabled);
  let reason: string | null = null;
  if (!fitsMemory || (coreCapacity > 0 && cpuWorkers === 0 && !gpuEnabled)) reason = 'RAM 한도가 부족해요. RAM 비율을 높여 주세요.';
  else if (!canRender) reason = limits.gpuPercent > 0 && !hints.gpuAvailable
    ? '이 브라우저에서 GPU를 사용할 수 없어요. CPU를 켜 주세요.' : 'CPU 또는 GPU 사용 비율을 높여 주세요.';
  return {
    cpuWorkers, cpuDutyCycle: cpuWorkers > 0 ? Math.min(1, coreCapacity / cpuWorkers) : 0,
    gpuEnabled: gpuEnabled && fitsMemory, gpuDutyCycle: gpuEnabled && fitsMemory ? limits.gpuPercent / 100 : 0,
    ramBudgetBytes, plannedBytes, frameBytes, chunkRows, maxCpuWorkers, canRender, reason,
  };
}
