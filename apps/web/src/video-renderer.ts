import { assertVideoInput } from '@tabcloud/compute';
import type { VideoFrameTask } from '@tabcloud/shared';
import { detectDeviceResources, MAX_RENDER_MEMORY_BYTES, normalizeResourceLimits, UNKNOWN_DEVICE_MEMORY_BYTES,
  type DeviceResources, type ResourceLimits, type ResourcePlan } from './resource-budget';
import { createVideoGpuProcessor, VIDEO_GPU_STRIP_ROWS, type VideoGpuProcessor } from './video-gpu';
import type { VideoCpuRequest, VideoCpuResponse } from './video-cpu.worker';

export interface VideoResourcePlan extends ResourcePlan { inputBytes: number; cpuStripRows: number; gpuStripRows: number }
export function planVideoResources(dimensions: { width: number; height: number }, input: ResourceLimits, hints: DeviceResources): VideoResourcePlan {
  if (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) || dimensions.width < 1 || dimensions.width > 1280
    || dimensions.height < 1 || dimensions.height > 720) throw new RangeError('Unsupported video dimensions.');
  const limits = normalizeResourceLimits(input);
  const device = detectDeviceResources({ hardwareConcurrency: hints.logicalCores, deviceMemory: hints.deviceMemoryGiB ?? undefined });
  const frameBytes = dimensions.width * dimensions.height * 4;
  const cpuStripRows = Math.min(16, dimensions.height);
  const gpuStripRows = Math.min(VIDEO_GPU_STRIP_ROWS, dimensions.height);
  const gpuRequested = hints.gpuAvailable && limits.gpuPercent > 0;
  const availableMemory = device.deviceMemoryGiB === null ? UNKNOWN_DEVICE_MEMORY_BYTES : device.deviceMemoryGiB * 1024 ** 3;
  const ramBudgetBytes = Math.floor(Math.min(MAX_RENDER_MEMORY_BYTES, availableMemory * limits.ramPercent / 100));
  const coreCapacity = device.logicalCores * limits.cpuPercent / 100;
  const maxCpuWorkers = Math.min(16, device.logicalCores, Math.ceil(dimensions.height / cpuStripRows), Math.ceil(coreCapacity));
  // Main input/output and upload copy, persistent GPU input and bounded output/readback/JS strip.
  const fixed = frameBytes * 3 + 128 * 1024 + (gpuRequested ? frameBytes + dimensions.width * gpuStripRows * 12 + 1024 : 0);
  // A separate immutable source copy lives in each CPU Worker; reserve runtime headroom as well.
  const eachCpu = frameBytes + 8 * 1024 * 1024 + dimensions.width * cpuStripRows * 8;
  const cpuWorkers = Math.min(maxCpuWorkers, Math.max(0, Math.floor((ramBudgetBytes - fixed) / eachCpu)));
  const plannedBytes = fixed + cpuWorkers * eachCpu;
  const fits = plannedBytes <= ramBudgetBytes && ramBudgetBytes > 0;
  const gpuEnabled = gpuRequested && fits;
  const canRender = fits && (cpuWorkers > 0 || gpuEnabled);
  const reason = !fits || (coreCapacity > 0 && cpuWorkers === 0 && !gpuEnabled) ? 'RAM 한도가 부족해요. RAM 비율을 높여 주세요.'
    : canRender ? null : limits.gpuPercent > 0 && !hints.gpuAvailable ? '하드웨어 GPU를 사용할 수 없어요. CPU를 켜 주세요.' : 'CPU 또는 GPU 사용 비율을 높여 주세요.';
  return { cpuWorkers, cpuDutyCycle: cpuWorkers ? Math.min(1, coreCapacity / cpuWorkers) : 0,
    gpuEnabled, gpuDutyCycle: gpuEnabled ? limits.gpuPercent / 100 : 0, ramBudgetBytes, plannedBytes,
    frameBytes, inputBytes: frameBytes, chunkRows: cpuStripRows, cpuStripRows, gpuStripRows, maxCpuWorkers, canRender, reason };
}

export interface VideoRenderStats {
  cpuActiveMs: number; gpuActiveMs: number; completedRows: number; trackedBytes: number; engine: string;
  cpuRows: number; gpuRows: number; frameCpuRows: number; frameGpuRows: number;
  gpuFrames: number; gpuDispatches: number; adapterName: string | null; gpuHardware: boolean;
  gpuTimestampMs: number | null; warning: string | null;
}
export interface VideoCpuWorker {
  onmessage: ((event: MessageEvent<VideoCpuResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: VideoCpuRequest, options?: StructuredSerializeOptions): void;
  terminate(): void;
}
export interface VideoRendererDependencies {
  createCpuWorker?: () => VideoCpuWorker;
  createGpuProcessor?: typeof createVideoGpuProcessor;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
function abortError(): Error { const error = new Error('Video processing cancelled.'); error.name = 'AbortError'; return error; }
function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, milliseconds);
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

export interface VideoProcessor {
  processFrame(input: Uint8ClampedArray, task: VideoFrameTask, limits: ResourceLimits, device: DeviceResources,
    options?: { signal?: AbortSignal; onProgress?: (rows: number, stats: VideoRenderStats) => void }): Promise<{ pixels: Uint8ClampedArray; elapsedMs: number; stats: VideoRenderStats }>;
  destroy(): void;
}

/** Keeps the hardware device/pipeline and CPU Worker pool warm across a consenting browser's frames. */
export function createVideoProcessor(dependencies: VideoRendererDependencies = {}): VideoProcessor {
  let gpu: VideoGpuProcessor | null = null;
  let gpuTried = false;
  let gpuFailure: string | null = null;
  const workers: VideoCpuWorker[] = [];
  let active: AbortController | null = null;
  let destroyed = false;
  let cpuActiveMs = 0; let gpuActiveMs = 0; let cpuRows = 0; let gpuRows = 0; let gpuFrames = 0; let gpuDispatches = 0;
  let gpuTimestampMs: number | null = null;
  const now = dependencies.now ?? (() => performance.now());
  const pause = dependencies.sleep ?? sleep;
  const destroy = () => {
    destroyed = true; active?.abort(); for (const worker of workers.splice(0)) worker.terminate(); gpu?.destroy(); gpu = null;
  };
  return {
    destroy,
    async processFrame(input, task, limits, device, options = {}) {
      if (destroyed) throw new Error('Video processor has been stopped.');
      if (active) throw new Error('A video frame is already processing.');
      if (options.signal?.aborted) throw abortError();
      assertVideoInput(input, task);
      const plan = planVideoResources(task, limits, device);
      if (!plan.canRender) throw new Error(plan.reason ?? 'No processing resources are enabled.');
      const controller = new AbortController(); active = controller;
      const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
      const assertActive = () => { if (controller.signal.aborted || destroyed) throw abortError(); };
      const started = now();
      let frameCpuRows = 0; let frameGpuRows = 0; let nextRow = 0; let reservedCpuBytes = 0; let frameGpu = false;
      let engine = 'CPU'; let warning: string | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const output = new Uint8ClampedArray(plan.frameBytes);
      const snapshot = (): VideoRenderStats => ({ cpuActiveMs, gpuActiveMs, completedRows: frameCpuRows + frameGpuRows,
        trackedBytes: plan.frameBytes * 2 + reservedCpuBytes + (frameGpu ? (gpu?.allocatedBytes ?? 0) + task.width * plan.gpuStripRows * 4 : 0),
        cpuRows, gpuRows, frameCpuRows, frameGpuRows, gpuFrames, gpuDispatches, engine,
        adapterName: frameGpu ? gpu?.adapterName ?? null : null, gpuHardware: frameGpu, gpuTimestampMs, warning });
      const emit = () => { const stats = snapshot(); options.onProgress?.(stats.completedRows, stats); };
      const take = (count: number) => {
        assertActive(); if (nextRow >= task.height) return null;
        const startRow = nextRow; const rowCount = Math.min(count, task.height - startRow); nextRow += rowCount;
        return { startRow, rowCount };
      };
      const merge = (startRow: number, rowCount: number, pixels: Uint8ClampedArray) => {
        assertActive(); if (pixels.byteLength !== task.width * rowCount * 4) throw new Error('Video processor returned an invalid strip.');
        output.set(pixels, task.width * startRow * 4);
      };
      const cpuRequest = (worker: VideoCpuWorker, message: Exclude<VideoCpuRequest, { type: 'cancel' | 'release' }>, transfer?: ArrayBuffer[]): Promise<VideoCpuResponse> => new Promise((resolve, reject) => {
        const clean = () => { controller.signal.removeEventListener('abort', stop); worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; };
        const fail = (error: Error) => { clean(); reject(error); };
        const stop = () => fail(abortError());
        controller.signal.addEventListener('abort', stop, { once: true });
        worker.onerror = (event) => fail(new Error(event.message || 'CPU video Worker failed.'));
        worker.onmessageerror = () => fail(new Error('CPU video Worker message could not be read.'));
        worker.onmessage = ({ data }) => {
          if (data.token !== message.token || data.type === 'progress') return;
          if (data.type === 'error') { fail(new Error(data.message)); return; }
          clean(); resolve(data);
        };
        if (controller.signal.aborted) { stop(); return; }
        try { worker.postMessage(message, transfer ? { transfer } : undefined); } catch (error) { fail(error instanceof Error ? error : new Error('CPU Worker could not start.')); }
      });
      try {
        if (!plan.gpuEnabled && gpu) { gpu.destroy(); gpu = null; gpuTried = false; gpuFailure = null; }
        if (plan.gpuEnabled) {
          if (!gpuTried || gpu?.lost) {
            gpu?.destroy(); gpu = null; gpuTried = true;
            try { gpu = await (dependencies.createGpuProcessor ?? createVideoGpuProcessor)({ signal: controller.signal }); gpuFailure = gpu ? null : '하드웨어 GPU에 연결하지 못했어요.'; }
            catch (error) { assertActive(); gpuFailure = error instanceof Error ? error.message : 'GPU 초기화에 실패했어요.'; }
          }
          assertActive();
          if (!gpu && plan.cpuWorkers === 0) throw new Error(gpuFailure ?? 'GPU를 사용할 수 없어요. CPU 사용을 허용해 주세요.');
          frameGpu = gpu !== null;
          if (!gpu) warning = `${gpuFailure} 허용한 CPU로 처리해요.`;
        }
        while (workers.length > plan.cpuWorkers) workers.pop()!.terminate();
        while (workers.length < plan.cpuWorkers) workers.push((dependencies.createCpuWorker ?? (() => new Worker(new URL('./video-cpu.worker.ts', import.meta.url), { type: 'module' })))());
        engine = frameGpu ? `${workers.length ? 'CPU + ' : ''}GPU · ${gpu!.adapterName}` : warning ? 'CPU · GPU 사용 불가' : 'CPU';
        if (frameGpu) gpu!.beginFrame(input, task);
        reservedCpuBytes = workers.length * (plan.frameBytes + task.width * plan.cpuStripRows * 4);
        await Promise.all(workers.map(async (worker, index) => {
          const copy = input.slice().buffer as ArrayBuffer;
          const result = await cpuRequest(worker, { type: 'initialize', token: `${task.taskId}:init:${index}`, task, pixels: copy }, [copy]);
          if (result.type !== 'ready') throw new Error('CPU Worker did not acknowledge the video frame.');
        }));
        assertActive(); emit(); heartbeat = setInterval(emit, 900);
        const cpuLoop = async (worker: VideoCpuWorker) => {
          for (let strip = take(plan.cpuStripRows); strip; strip = take(plan.cpuStripRows)) {
            const result = await cpuRequest(worker, { type: 'render', token: `${task.taskId}:row:${strip.startRow}`, ...strip, dutyCycle: plan.cpuDutyCycle });
            if (result.type !== 'done' || !(result.pixels instanceof ArrayBuffer) || !Number.isFinite(result.activeMs) || result.activeMs < 0) throw new Error('Invalid CPU video result.');
            merge(strip.startRow, strip.rowCount, new Uint8ClampedArray(result.pixels));
            cpuActiveMs += result.activeMs; cpuRows += strip.rowCount; frameCpuRows += strip.rowCount; emit();
          }
        };
        const gpuLoop = async () => {
          if (!frameGpu || !gpu) return;
          for (let strip = take(plan.gpuStripRows); strip; strip = take(plan.gpuStripRows)) {
            const result = await gpu.renderStrip(strip.startRow, strip.rowCount, { signal: controller.signal });
            if (!Number.isFinite(result.busyMs) || result.busyMs < 0) throw new Error('Invalid GPU timing.');
            merge(strip.startRow, strip.rowCount, result.pixels);
            gpuActiveMs += result.busyMs; gpuRows += strip.rowCount; frameGpuRows += strip.rowCount; gpuDispatches += 1;
            if (result.timestampMs !== null && Number.isFinite(result.timestampMs) && result.timestampMs >= 0) gpuTimestampMs = (gpuTimestampMs ?? 0) + result.timestampMs;
            emit();
            const idle = Math.ceil(result.busyMs * (1 / plan.gpuDutyCycle - 1));
            if (idle > 0) await pause(idle, controller.signal);
          }
        };
        await Promise.all([gpuLoop(), ...workers.map(cpuLoop)]);
        assertActive();
        if (frameCpuRows + frameGpuRows !== task.height) throw new Error('Video frame did not finish every row.');
        if (frameGpuRows > 0) gpuFrames += 1;
        return { pixels: output, elapsedMs: Math.max(0, now() - started), stats: snapshot() };
      } catch (error) {
        controller.abort(); for (const worker of workers.splice(0)) worker.terminate();
        gpu?.destroy(); gpu = null; gpuTried = false;
        throw error;
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        for (const worker of workers) worker.postMessage({ type: 'release' });
        options.signal?.removeEventListener('abort', abort); active = null;
      }
    },
  };
}
