import { describe, expect, it } from 'vitest';
import { processVideoFrame, processVideoRows } from '@tabcloud/compute';
import { DEFAULT_VIDEO_PROCESSING, type VideoFrameTask } from '@tabcloud/shared';
import { createVideoProcessor, planVideoResources, type VideoCpuWorker } from './video-renderer';
import type { VideoCpuRequest, VideoCpuResponse } from './video-cpu.worker';
import type { VideoGpuProcessor } from './video-gpu';

const task: VideoFrameTask = { jobId: 'test', taskId: 'frame:0', frameIndex: 0, width: 64, height: 96, settings: { ...DEFAULT_VIDEO_PROCESSING }, algorithmVersion: 'video-filter-v1' };
const input = Uint8ClampedArray.from({ length: task.width * task.height * 4 }, (_, index) => index % 256);
const device = { logicalCores: 8, deviceMemoryGiB: 8, gpuAvailable: true };
const limits = { cpuPercent: 25, gpuPercent: 100, ramPercent: 10 };
class Cpu implements VideoCpuWorker {
  onmessage: VideoCpuWorker['onmessage'] = null; onerror: VideoCpuWorker['onerror'] = null; onmessageerror: VideoCpuWorker['onmessageerror'] = null;
  frame: { input: Uint8ClampedArray; task: VideoFrameTask } | null = null; stopped = false; duties: number[] = [];
  postMessage(data: VideoCpuRequest) {
    if (data.type === 'release') { this.frame = null; return; }
    if (data.type === 'cancel') return;
    queueMicrotask(() => {
      if (this.stopped) return;
      const emit = (message: VideoCpuResponse) => this.onmessage?.({ data: message } as MessageEvent<VideoCpuResponse>);
      if (data.type === 'initialize') { this.frame = { input: new Uint8ClampedArray(data.pixels), task: data.task }; emit({ type: 'ready', token: data.token }); }
      else {
        this.duties.push(data.dutyCycle);
        const pixels = processVideoRows(this.frame!.input, this.frame!.task, data.startRow, data.rowCount).buffer as ArrayBuffer;
        emit({ type: 'done', token: data.token, pixels, activeMs: 3 });
      }
    });
  }
  terminate() { this.stopped = true; this.frame = null; }
}
function fakeGpu() {
  let frame = { input, task }; let frames = 0; let dispatches = 0; let stopped = false;
  const gpu: VideoGpuProcessor = {
    adapterName: 'test hardware', hardware: true, timestampSupported: true, allocatedBytes: input.byteLength + 4096,
    get lost() { return stopped; },
    beginFrame(input, task) { frame = { input: new Uint8ClampedArray(input), task }; frames += 1; },
    async renderStrip(row, count) { dispatches += 1; return { pixels: processVideoRows(frame.input, frame.task, row, count), busyMs: 4, timestampMs: 2 }; },
    destroy() { stopped = true; },
  };
  return { gpu, counts: () => ({ frames, dispatches, stopped }) };
}

describe('video resource scheduling', () => {
  it('accounts for full per-CPU input copies, GPU buffers and both zero resource switches', () => {
    const plan = planVideoResources(task, limits, device);
    expect(plan.cpuWorkers).toBe(2); expect(plan.plannedBytes).toBeGreaterThan(task.width * task.height * 4 * 6);
    expect(planVideoResources(task, { ...limits, ramPercent: 0 }, device).canRender).toBe(false);
    expect(planVideoResources(task, { ...limits, cpuPercent: 0, gpuPercent: 0 }, device).canRender).toBe(false);
  });
  it('never acquires a GPU device at 0% and gives CPU strips an enforced fractional budget', async () => {
    let gpuCalls = 0; const workers: Cpu[] = [];
    const processor = createVideoProcessor({ createGpuProcessor: async () => { gpuCalls += 1; return null; }, createCpuWorker: () => { const cpu = new Cpu(); workers.push(cpu); return cpu; } });
    const result = await processor.processFrame(input, task, { ...limits, cpuPercent: 5, gpuPercent: 0 }, device);
    expect(result.pixels).toEqual(processVideoFrame(input, task)); expect(gpuCalls).toBe(0);
    expect(workers).toHaveLength(1); expect(workers[0]!.duties.every((duty) => duty === 0.4)).toBe(true);
    expect(result.stats.frameGpuRows).toBe(0); expect(result.stats.frameCpuRows).toBe(task.height);
    processor.destroy(); expect(workers[0]!.stopped).toBe(true);
  });
  it('GPU-only processing creates no CPU Workers and reuses the same device/pipeline across frames', async () => {
    const fake = fakeGpu(); let gpuCreates = 0; let cpuCreates = 0; const pauses: number[] = [];
    const processor = createVideoProcessor({ createGpuProcessor: async () => { gpuCreates += 1; return fake.gpu; },
      createCpuWorker: () => { cpuCreates += 1; return new Cpu(); }, sleep: async (milliseconds) => { pauses.push(milliseconds); } });
    const first = await processor.processFrame(input, task, { ...limits, cpuPercent: 0, gpuPercent: 50 }, device);
    const second = await processor.processFrame(input, { ...task, taskId: 'frame:1', frameIndex: 1 }, { ...limits, cpuPercent: 0, gpuPercent: 50 }, device);
    expect(first.pixels).toEqual(processVideoFrame(input, task)); expect(second.pixels).toEqual(first.pixels);
    expect(gpuCreates).toBe(1); expect(cpuCreates).toBe(0); expect(fake.counts()).toEqual({ frames: 2, dispatches: 4, stopped: false });
    expect(second.stats.gpuFrames).toBe(2); expect(second.stats.gpuDispatches).toBe(4); expect(second.stats.gpuTimestampMs).toBe(8);
    expect(second.stats.cpuRows).toBe(0); expect(second.stats.gpuRows).toBe(192); expect(pauses).toEqual([4, 4, 4, 4]);
    processor.destroy(); expect(fake.counts().stopped).toBe(true);
  });
  it('mixes exact CPU/GPU strips without overlap and retains CPU Workers for later frames', async () => {
    const fake = fakeGpu(); const workers: Cpu[] = [];
    const processor = createVideoProcessor({ createGpuProcessor: async () => fake.gpu, createCpuWorker: () => { const cpu = new Cpu(); workers.push(cpu); return cpu; } });
    const first = await processor.processFrame(input, task, limits, device);
    const second = await processor.processFrame(input, { ...task, taskId: 'frame:1' }, limits, device);
    expect(first.pixels).toEqual(processVideoFrame(input, task)); expect(second.pixels).toEqual(first.pixels);
    expect(first.stats.frameCpuRows).toBeGreaterThan(0); expect(first.stats.frameGpuRows).toBeGreaterThan(0);
    expect(first.stats.frameCpuRows + first.stats.frameGpuRows).toBe(task.height);
    expect(workers).toHaveLength(2); processor.destroy(); expect(workers.every((worker) => worker.stopped)).toBe(true);
  });
  it('uses CPU fallback only when CPU was explicitly allowed and reports the GPU failure', async () => {
    const processor = createVideoProcessor({ createGpuProcessor: async () => { throw new Error('Software GPU rejected'); }, createCpuWorker: () => new Cpu() });
    const result = await processor.processFrame(input, task, limits, device);
    expect(result.stats.warning).toContain('Software GPU rejected'); expect(result.stats.gpuHardware).toBe(false); expect(result.stats.cpuRows).toBe(96);
    processor.destroy();
    const gpuOnly = createVideoProcessor({ createGpuProcessor: async () => null, createCpuWorker: () => { throw new Error('CPU must remain disabled'); } });
    await expect(gpuOnly.processFrame(input, task, { ...limits, cpuPercent: 0 }, device)).rejects.toThrow('GPU'); gpuOnly.destroy();
  });
  it('aborting a pending GPU dispatch terminates its CPU peers and destroys GPU resources', async () => {
    const fake = fakeGpu(); const workers: Cpu[] = []; let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
    fake.gpu.renderStrip = async (_row, _count, options) => new Promise((_resolve, reject) => {
      entered(); options!.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    });
    const processor = createVideoProcessor({ createGpuProcessor: async () => fake.gpu, createCpuWorker: () => { const cpu = new Cpu(); workers.push(cpu); return cpu; } });
    const controller = new AbortController(); const pending = processor.processFrame(input, task, limits, device, { signal: controller.signal });
    await ready; controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.counts().stopped).toBe(true); expect(workers.every((worker) => worker.stopped)).toBe(true); processor.destroy();
  });
});
