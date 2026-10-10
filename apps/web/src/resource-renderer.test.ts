import { describe, expect, it } from 'vitest';
import { renderAnimationFrame } from '@tabcloud/compute';
import type { FrameTask } from '@tabcloud/shared';
import type { CpuWorkerRequest, CpuWorkerResponse } from './cpu-render.worker';
import type { GpuRenderer } from './gpu-renderer';
import { DEFAULT_RESOURCE_LIMITS, planResources, type ResourceLimits } from './resource-budget';
import { renderResourceFrame, type ResourceCpuWorker, type ResourceRendererDependencies, type ResourceRenderStats } from './resource-renderer';

const task: FrameTask = {
  jobId: 'resource-test', taskId: 'frame:0', frameIndex: 0, algorithmVersion: 'raytrace-v1',
  settings: { width: 64, height: 64, frames: 1, fps: 24, samples: 1, bounces: 2 },
};
const device = { logicalCores: 8, deviceMemoryGiB: 8, gpuAvailable: true };
const reference = renderAnimationFrame(task);
const limits = (overrides: Partial<ResourceLimits> = {}): ResourceLimits => ({ ...DEFAULT_RESOURCE_LIMITS, ...overrides });
const bytesFor = (start: number, rows: number) => reference.slice(start * 64 * 4, (start + rows) * 64 * 4);

class FakeCpuWorker implements ResourceCpuWorker {
  onmessage: ResourceCpuWorker['onmessage'] = null;
  onerror: ResourceCpuWorker['onerror'] = null;
  onmessageerror: ResourceCpuWorker['onmessageerror'] = null;
  terminated = false;
  requests: Extract<CpuWorkerRequest, { type: 'render' }>[] = [];
  constructor(private mode: 'normal' | 'pending' | 'failure' | 'malformed' = 'normal') {}
  postMessage(request: CpuWorkerRequest) {
    if (request.type !== 'render') return;
    this.requests.push(request);
    if (this.mode === 'pending') return;
    queueMicrotask(() => {
      if (this.terminated) return;
      const publish = (data: CpuWorkerResponse) => this.onmessage?.({ data } as MessageEvent<CpuWorkerResponse>);
      if (this.mode === 'failure') { publish({ type: 'error', token: request.token, message: 'CPU stopped' }); return; }
      publish({ type: 'progress', token: 'stale-token', rows: 64 });
      publish({ type: 'progress', token: request.token, rows: request.rowCount });
      const pixels = this.mode === 'malformed' ? new Uint8ClampedArray(1) : bytesFor(request.startRow, request.rowCount);
      publish({ type: 'done', token: request.token, pixels: pixels.buffer as ArrayBuffer, activeMs: 2, elapsedMs: 3 });
    });
  }
  terminate() { this.terminated = true; }
}

function setup(mode: ConstructorParameters<typeof FakeCpuWorker>[0] = 'normal') {
  const workers: FakeCpuWorker[] = [];
  const gpuStrips: { start: number; rows: number }[] = [];
  let gpuCreated = 0;
  let gpuDestroyed = false;
  const idle: number[] = [];
  const gpu: GpuRenderer = {
    label: 'Test GPU', isFallbackAdapter: false, lost: false,
    destroy: () => { gpuDestroyed = true; },
    renderStrip: async (_task, start, rows) => {
      gpuStrips.push({ start, rows });
      return { pixels: bytesFor(start, rows), busyMs: 4, correctedPixels: 0 };
    },
  };
  const dependencies: ResourceRendererDependencies = {
    createCpuWorker: () => { const worker = new FakeCpuWorker(mode); workers.push(worker); return worker; },
    createGpuRenderer: async () => { gpuCreated += 1; return gpu; },
    sleep: async (ms) => { idle.push(ms); },
  };
  return { workers, gpuStrips, gpu, dependencies, idle, gpuCreated: () => gpuCreated, gpuDestroyed: () => gpuDestroyed };
}

describe('resource-aware frame scheduler', () => {
  it('shares unique bounded strips between CPU Workers and merges the exact full frame', async () => {
    const fake = setup();
    const progress: ResourceRenderStats[] = [];
    const result = await renderResourceFrame(task, limits({ cpuPercent: 15 }), device,
      { onProgress: (_rows, stats) => progress.push(stats) }, fake.dependencies);
    expect(result.pixels).toEqual(reference);
    expect(fake.workers).toHaveLength(2);
    const requests = fake.workers.flatMap((worker) => worker.requests);
    expect(requests.map((request) => request.startRow).sort((a, b) => a - b)).toEqual([0, 8, 16, 24, 32, 40, 48, 56]);
    expect(requests.every((request) => request.rowCount <= 8 && request.dutyCycle === 0.6)).toBe(true);
    expect(progress.every((stats, index) => stats.completedRows >= (progress[index - 1]?.completedRows ?? 0))).toBe(true);
    expect(result.stats).toMatchObject({ completedRows: 64, cpuActiveMs: 16, gpuActiveMs: 0, trackedBytes: reference.byteLength, engine: 'CPU' });
    expect(fake.gpuCreated()).toBe(0);
    expect(fake.workers.every((worker) => worker.terminated)).toBe(true);
    const plan = planResources(task.settings, limits({ cpuPercent: 15 }), device);
    expect(progress.every((stats) => stats.trackedBytes <= plan.plannedBytes)).toBe(true);
  });

  it('runs genuine GPU work alongside CPU and includes final GPU duty delay', async () => {
    const fake = setup();
    const result = await renderResourceFrame(task, limits({ gpuPercent: 25 }), device, {}, fake.dependencies);
    const starts = [...fake.gpuStrips.map((strip) => strip.start), ...fake.workers.flatMap((worker) => worker.requests.map((request) => request.startRow))];
    expect(new Set(starts).size).toBe(8);
    expect(starts).toHaveLength(8);
    expect(fake.gpuStrips.length).toBeGreaterThan(0);
    expect(fake.workers.some((worker) => worker.requests.length > 0)).toBe(true);
    expect(result.pixels).toEqual(reference);
    expect(fake.idle).toHaveLength(fake.gpuStrips.length);
    expect(fake.idle.every((ms) => ms === 12)).toBe(true);
    expect(result.stats.gpuActiveMs).toBe(fake.gpuStrips.length * 4);
    expect(result.stats.engine).toBe('CPU + WebGPU · Test GPU');
    expect(fake.gpuDestroyed()).toBe(true);
  });

  it('honors CPU zero and identifies a software WebGPU adapter', async () => {
    const fake = setup();
    fake.dependencies.createGpuRenderer = async () => ({ ...fake.gpu, isFallbackAdapter: true, label: 'SwiftShader' });
    const result = await renderResourceFrame(task, limits({ cpuPercent: 0, gpuPercent: 50 }), device, {}, fake.dependencies);
    expect(fake.workers).toHaveLength(0);
    expect(fake.gpuStrips).toHaveLength(8);
    expect(fake.idle).toEqual(Array<number>(8).fill(4));
    expect(result.stats.engine).toBe('WebGPU 소프트웨어 · SwiftShader');
    expect(result.pixels).toEqual(reference);
  });

  it('falls back only to the already allowed CPU capacity after GPU initialization fails', async () => {
    const fake = setup();
    fake.dependencies.createGpuRenderer = async () => { throw new Error('No adapter'); };
    const result = await renderResourceFrame(task, limits({ cpuPercent: 5, gpuPercent: 100 }), device, {}, fake.dependencies);
    expect(fake.workers).toHaveLength(1);
    expect(fake.workers[0]!.requests.every((request) => request.dutyCycle === 0.4)).toBe(true);
    expect(result.stats.engine).toBe('CPU · GPU 사용 불가');
    expect(result.pixels).toEqual(reference);
    fake.dependencies.createGpuRenderer = async () => null;
    await expect(renderResourceFrame(task, limits({ cpuPercent: 0, gpuPercent: 100 }), device, {}, fake.dependencies)).rejects.toThrow('CPU');
  });

  it('never allocates a Worker or GPU when all compute or RAM budgets are disabled', async () => {
    const fake = setup();
    for (const settings of [limits({ cpuPercent: 0 }), limits({ ramPercent: 0, gpuPercent: 50 })]) {
      await expect(renderResourceFrame(task, settings, device, {}, fake.dependencies)).rejects.toThrow();
    }
    expect(fake.workers).toHaveLength(0);
    expect(fake.gpuCreated()).toBe(0);
  });

  it.each(['failure', 'malformed'] as const)('terminates every Worker and rejects partial output on CPU %s', async (mode) => {
    const fake = setup(mode);
    await expect(renderResourceFrame(task, limits(), device, {}, fake.dependencies)).rejects.toThrow();
    expect(fake.workers.length).toBeGreaterThan(0);
    expect(fake.workers.every((worker) => worker.terminated)).toBe(true);
  });

  it('does not silently retry GPU runtime errors as unbudgeted CPU work', async () => {
    const fake = setup();
    fake.gpu.renderStrip = async () => { throw new Error('GPU device lost'); };
    await expect(renderResourceFrame(task, limits({ gpuPercent: 50 }), device, {}, fake.dependencies)).rejects.toThrow('GPU device lost');
    expect(fake.gpuDestroyed()).toBe(true);
    expect(fake.workers.every((worker) => worker.terminated)).toBe(true);
  });

  it('cancels pending CPU strips and destroys GPU resources without publishing a frame', async () => {
    const fake = setup('pending');
    const controller = new AbortController();
    fake.dependencies.sleep = async () => { controller.abort(); };
    await expect(renderResourceFrame(task, limits({ gpuPercent: 50 }), device, { signal: controller.signal }, fake.dependencies)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.gpuDestroyed()).toBe(true);
    expect(fake.workers.every((worker) => worker.terminated)).toBe(true);
  });
});
