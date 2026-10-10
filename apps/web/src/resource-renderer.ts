import type { FrameTask } from '@tabcloud/shared';
import type { CpuWorkerRequest, CpuWorkerResponse } from './cpu-render.worker';
import { createGpuRenderer, type GpuRenderer } from './gpu-renderer';
import { planResources, type DeviceResources, type ResourceLimits } from './resource-budget';

export interface ResourceRenderStats {
  cpuActiveMs: number;
  gpuActiveMs: number;
  completedRows: number;
  trackedBytes: number;
  engine: string;
}
export interface ResourceRenderOptions {
  onProgress?: (completedRows: number, stats: ResourceRenderStats) => void;
  signal?: AbortSignal;
}
export interface ResourceCpuWorker {
  onmessage: ((event: MessageEvent<CpuWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: CpuWorkerRequest): void;
  terminate(): void;
}
export interface ResourceRendererDependencies {
  createCpuWorker?: () => ResourceCpuWorker;
  createGpuRenderer?: typeof createGpuRenderer;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

function abortError(): Error {
  const error = new Error('Rendering cancelled.');
  error.name = 'AbortError';
  return error;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * A single leased frame is split across a device's CPU Workers and optional WebGPU
 * engine. Faster engines take the next bounded strip; all strips share identical
 * scene quality and seeds. Neither hardware percentages nor free RAM are measurable
 * here: limits govern this renderer's concurrency, duty cycle and buffer budget.
 */
export async function renderResourceFrame(task: FrameTask, limits: ResourceLimits, device: DeviceResources,
  options: ResourceRenderOptions = {}, dependencies: ResourceRendererDependencies = {}): Promise<{
    pixels: Uint8ClampedArray; stats: ResourceRenderStats; elapsedMs: number;
  }> {
  const plan = planResources(task.settings, limits, device);
  if (!plan.canRender) throw new Error(plan.reason ?? 'No rendering resources are enabled.');
  if (options.signal?.aborted) throw abortError();
  const now = dependencies.now ?? (() => performance.now());
  const started = now();
  const wait = dependencies.sleep ?? sleep;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const assertActive = () => { if (controller.signal.aborted) throw abortError(); };
  const workers: ResourceCpuWorker[] = [];
  let gpu: GpuRenderer | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const pixels = new Uint8ClampedArray(plan.frameBytes);
  const cpuProgress = new Map<number, { rows: number; rowCount: number }>();
  let nextRow = 0;
  let completedRows = 0;
  let gpuRows = 0;
  let maxReportedRows = 0;
  let cpuActiveMs = 0;
  let gpuActiveMs = 0;
  let engine = plan.cpuWorkers > 0 ? 'CPU' : 'WebGPU';
  const stats = (): ResourceRenderStats => {
    let activeRows = 0;
    let cpuBytes = 0;
    for (const progress of cpuProgress.values()) {
      activeRows += progress.rows;
      cpuBytes += progress.rowCount * task.settings.width * 4;
    }
    maxReportedRows = Math.max(maxReportedRows, Math.min(task.settings.height, completedRows + activeRows));
    return {
      cpuActiveMs, gpuActiveMs, completedRows: maxReportedRows,
      // Explicitly owned output/strip buffers. Worker heaps, driver overhead and browser memory are not measurable.
      trackedBytes: plan.frameBytes + cpuBytes + (gpuRows > 0 ? gpuRows * task.settings.width * 20 + 352 : 0), engine,
    };
  };
  const emit = () => { const snapshot = stats(); options.onProgress?.(snapshot.completedRows, snapshot); };
  const takeStrip = () => {
    assertActive();
    if (nextRow >= task.settings.height) return null;
    const startRow = nextRow;
    const rowCount = Math.min(plan.chunkRows, task.settings.height - startRow);
    nextRow += rowCount;
    return { startRow, rowCount };
  };
  const merge = (startRow: number, rowCount: number, result: Uint8ClampedArray) => {
    assertActive();
    if (result.byteLength !== rowCount * task.settings.width * 4) throw new Error('Renderer returned an invalid row buffer.');
    pixels.set(result, startRow * task.settings.width * 4);
    completedRows += rowCount;
  };
  const runCpuStrip = (worker: ResourceCpuWorker, startRow: number, rowCount: number): Promise<{ pixels: Uint8ClampedArray; activeMs: number }> => {
    const token = `cpu:${startRow}`;
    cpuProgress.set(startRow, { rows: 0, rowCount });
    return new Promise((resolve, reject) => {
      const clean = () => {
        controller.signal.removeEventListener('abort', cancelled);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      };
      const fail = (error: Error) => { clean(); reject(error); };
      const cancelled = () => fail(abortError());
      controller.signal.addEventListener('abort', cancelled, { once: true });
      worker.onerror = (event) => fail(new Error(event.message || 'CPU Worker failed.'));
      worker.onmessageerror = () => fail(new Error('CPU Worker response could not be read.'));
      worker.onmessage = ({ data }) => {
        if (data.token !== token) return;
        if (data.type === 'error') { fail(new Error(data.message)); return; }
        if (data.type === 'progress') {
          const prior = cpuProgress.get(startRow);
          if (Number.isInteger(data.rows) && data.rows >= (prior?.rows ?? 0) && data.rows <= rowCount) {
            cpuProgress.set(startRow, { rows: data.rows, rowCount }); emit();
          }
          return;
        }
        if (!Number.isFinite(data.activeMs) || data.activeMs < 0 || !(data.pixels instanceof ArrayBuffer)) {
          fail(new Error('CPU Worker returned invalid timing or pixels.')); return;
        }
        clean(); resolve({ pixels: new Uint8ClampedArray(data.pixels), activeMs: data.activeMs });
      };
      if (controller.signal.aborted) { cancelled(); return; }
      try { worker.postMessage({ type: 'render', task, token, startRow, rowCount, dutyCycle: plan.cpuDutyCycle }); }
      catch (error) { fail(error instanceof Error ? error : new Error('CPU Worker could not start.')); }
    });
  };
  const cpuLoop = async (worker: ResourceCpuWorker) => {
    for (let strip = takeStrip(); strip; strip = takeStrip()) {
      const result = await runCpuStrip(worker, strip.startRow, strip.rowCount);
      merge(strip.startRow, strip.rowCount, result.pixels);
      cpuActiveMs += result.activeMs;
      cpuProgress.delete(strip.startRow);
      emit();
    }
  };
  const gpuLoop = async () => {
    if (!gpu) return;
    for (let strip = takeStrip(); strip; strip = takeStrip()) {
      gpuRows = strip.rowCount; emit();
      const busyMs = await (async () => {
        const result = await gpu.renderStrip(task, strip.startRow, strip.rowCount, { signal: controller.signal });
        if (!Number.isFinite(result.busyMs) || result.busyMs < 0) throw new Error('GPU returned invalid timing.');
        merge(strip.startRow, strip.rowCount, result.pixels);
        return result.busyMs;
      })();
      gpuActiveMs += busyMs;
      // Keep only the already merged full output across the budget's idle period.
      gpuRows = 0; emit();
      const idleMs = Math.ceil(busyMs * (1 / plan.gpuDutyCycle - 1));
      // Include the final strip: many short frames must not bypass a low GPU limit.
      if (idleMs > 0) await wait(idleMs, controller.signal);
      assertActive();
    }
  };
  try {
    if (plan.gpuEnabled) {
      try { gpu = await (dependencies.createGpuRenderer ?? createGpuRenderer)({ signal: controller.signal }); }
      catch (error) { assertActive(); if (plan.cpuWorkers === 0) throw error; }
      assertActive();
      if (!gpu && plan.cpuWorkers === 0) throw new Error('GPU를 사용할 수 없어요. CPU 사용을 켜 주세요.');
      if (gpu) {
        const gpuName = gpu.isFallbackAdapter ? `WebGPU 소프트웨어 · ${gpu.label}` : `WebGPU · ${gpu.label}`;
        engine = `${plan.cpuWorkers > 0 ? 'CPU + ' : ''}${gpuName}`;
      } else engine = 'CPU · GPU 사용 불가';
    }
    for (let index = 0; index < plan.cpuWorkers; index += 1) {
      workers.push((dependencies.createCpuWorker ?? (() => new Worker(new URL('./cpu-render.worker.ts', import.meta.url), { type: 'module' })))());
    }
    emit();
    heartbeat = setInterval(emit, 900);
    // Give the GPU a strip first, even when CPUs could initially claim every row of a small frame.
    await Promise.all([gpuLoop(), ...workers.map(cpuLoop)]);
    assertActive();
    if (completedRows !== task.settings.height) throw new Error('Rendering did not finish every frame row.');
    const finalStats = stats();
    return { pixels, stats: finalStats, elapsedMs: Math.max(0, now() - started) };
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    controller.abort();
    for (const worker of workers) worker.terminate();
    gpu?.destroy();
    options.signal?.removeEventListener('abort', abort);
  }
}
