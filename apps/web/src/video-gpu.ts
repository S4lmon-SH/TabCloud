import { assertVideoInput } from '@tabcloud/compute';
import type { VideoFrameTask } from '@tabcloud/shared';
import { videoShader } from './video-shader';

export const VIDEO_GPU_STRIP_ROWS = 64;
export interface VideoGpuStrip { pixels: Uint8ClampedArray; busyMs: number; timestampMs: number | null }
export interface VideoGpuProcessor {
  readonly adapterName: string;
  readonly hardware: true;
  readonly lost: boolean;
  readonly timestampSupported: boolean;
  readonly allocatedBytes: number;
  beginFrame(input: Uint8Array | Uint8ClampedArray, task: VideoFrameTask): void;
  renderStrip(startRow: number, rowCount: number, options?: { signal?: AbortSignal }): Promise<VideoGpuStrip>;
  destroy(): void;
}

function cancelled(): Error { const error = new Error('Video GPU processing cancelled.'); error.name = 'AbortError'; return error; }

function adapterDetails(adapter: GPUAdapter): { name: string; reason: string | null } {
  const info = adapter.info;
  const name = [info.vendor, info.description || info.device || info.architecture].filter(Boolean).join(' · ') || 'WebGPU 하드웨어';
  const fallback = Reflect.get(info, 'isFallbackAdapter') ?? Reflect.get(adapter, 'isFallbackAdapter');
  if (fallback === true || /swiftshader|llvmpipe|software|warp|basic render/i.test(name)) {
    return { name, reason: '소프트웨어 GPU는 사용하지 않아요. 하드웨어 가속을 켜거나 CPU 사용을 허용해 주세요.' };
  }
  if (fallback !== false && !/nvidia|amd|intel|apple|qualcomm|adreno|mali|radeon|geforce|ampere|rdna/i.test(name)) {
    return { name, reason: '실제 GPU 어댑터인지 확인하지 못했어요. CPU 사용을 허용해 주세요.' };
  }
  return { name, reason: null };
}

/** Read-only capability probe: never creates a GPU device, buffers or a pipeline. */
export async function probeVideoGpu(): Promise<{ available: boolean; adapterName: string | null; reason: string | null }> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return { available: false, adapterName: null, reason: '이 브라우저는 WebGPU를 지원하지 않아요.' };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, adapterName: null, reason: '사용 가능한 GPU를 찾지 못했어요.' };
    const details = adapterDetails(adapter);
    return { available: !details.reason, adapterName: details.name, reason: details.reason };
  } catch { return { available: false, adapterName: null, reason: 'GPU에 연결하지 못했어요.' }; }
}

export async function createVideoGpuProcessor(options: { signal?: AbortSignal } = {}): Promise<VideoGpuProcessor | null> {
  if (options.signal?.aborted) throw cancelled();
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  let adapter: GPUAdapter | null;
  try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { return null; }
  if (options.signal?.aborted) throw cancelled();
  if (!adapter) return null;
  const { name, reason } = adapterDetails(adapter);
  if (reason) throw new Error(reason);
  const timestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });
  let lost = false;
  let busy = false;
  let task: VideoFrameTask | null = null;
  let source: GPUBuffer | null = null;
  let output: GPUBuffer | null = null;
  let readback: GPUBuffer | null = null;
  let group: GPUBindGroup | null = null;
  const uniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const queries = timestamps ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
  const queryResolve = timestamps ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const queryReadback = timestamps ? device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null;
  const destroy = () => {
    lost = true; source?.destroy(); output?.destroy(); readback?.destroy(); uniform.destroy();
    queries?.destroy(); queryResolve?.destroy(); queryReadback?.destroy(); device.destroy();
  };
  void device.lost.then(() => { lost = true; });
  const initAbort = () => destroy();
  options.signal?.addEventListener('abort', initAbort, { once: true });
  let pipeline: GPUComputePipeline;
  try {
    if (options.signal?.aborted) throw cancelled();
    const module = device.createShaderModule({ code: videoShader });
    const compilation = await module.getCompilationInfo();
    const shaderError = compilation.messages.find((message) => message.type === 'error');
    if (shaderError) throw new Error(`GPU 필터 준비 실패: ${shaderError.message}`);
    pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: {
      module, entryPoint: 'main',
    } });
    if (options.signal?.aborted) throw cancelled();
  } catch (error) { destroy(); if (options.signal?.aborted) throw cancelled(); throw error; }
  finally { options.signal?.removeEventListener('abort', initAbort); }

  return {
    adapterName: name, hardware: true, timestampSupported: timestamps,
    get lost() { return lost; },
    get allocatedBytes() { return (source?.size ?? 0) + (output?.size ?? 0) + (readback?.size ?? 0) + 48 + (timestamps ? 32 : 0); },
    destroy,
    beginFrame(input, nextTask) {
      if (lost) throw new Error('GPU 장치 연결이 끊겼어요.');
      if (busy) throw new Error('A GPU video strip is still processing.');
      assertVideoInput(input, nextTask);
      const frameBytes = nextTask.width * nextTask.height * 4;
      const stripBytes = nextTask.width * Math.min(VIDEO_GPU_STRIP_ROWS, nextTask.height) * 4;
      if (Math.max(frameBytes, stripBytes) > device.limits.maxBufferSize
        || Math.max(frameBytes, stripBytes) > device.limits.maxStorageBufferBindingSize
        || Math.ceil(nextTask.width / 16) > device.limits.maxComputeWorkgroupsPerDimension) {
        throw new Error('이 GPU의 영상 버퍼 한도를 넘었어요. 출력 해상도를 낮춰 주세요.');
      }
      if (!source || source.size !== frameBytes || !output || output.size !== stripBytes) {
        source?.destroy(); output?.destroy(); readback?.destroy();
        source = device.createBuffer({ size: frameBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        output = device.createBuffer({ size: stripBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        readback = device.createBuffer({ size: stripBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: source } },
          { binding: 2, resource: { buffer: output } },
        ] });
      }
      task = nextTask;
      device.queue.writeBuffer(source, 0, input.buffer as ArrayBuffer, input.byteOffset, input.byteLength);
    },
    async renderStrip(startRow, rowCount, stripOptions = {}) {
      if (stripOptions.signal?.aborted) throw cancelled();
      if (lost) throw new Error('GPU 장치 연결이 끊겼어요.');
      if (busy) throw new Error('A GPU video strip is already processing.');
      if (!task || !output || !readback || !group) throw new Error('No video frame has been uploaded to the GPU.');
      if (!Number.isInteger(startRow) || !Number.isInteger(rowCount) || startRow < 0 || rowCount < 1
        || rowCount > VIDEO_GPU_STRIP_ROWS || startRow + rowCount > task.height) throw new RangeError('Invalid video GPU strip bounds.');
      const parameters = new ArrayBuffer(48);
      new Uint32Array(parameters, 0, 4).set([task.width, task.height, startRow, rowCount]);
      new Int32Array(parameters, 16, 8).set([task.settings.denoise, task.settings.denoiseRadius, task.settings.sharpen,
        task.settings.brightness, task.settings.contrast, task.settings.saturation, 0, 0]);
      const bytes = task.width * rowCount * 4;
      const abort = () => destroy();
      stripOptions.signal?.addEventListener('abort', abort, { once: true });
      busy = true;
      const started = performance.now();
      try {
        device.queue.writeBuffer(uniform, 0, parameters);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass(queries ? { timestampWrites: {
          querySet: queries, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1,
        } } : undefined);
        pass.setPipeline(pipeline); pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(task.width / 16), Math.ceil(rowCount / 8)); pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
        if (queries && queryResolve && queryReadback) {
          encoder.resolveQuerySet(queries, 0, 2, queryResolve, 0);
          encoder.copyBufferToBuffer(queryResolve, 0, queryReadback, 0, 16);
        }
        device.queue.submit([encoder.finish()]);
        await Promise.all([readback.mapAsync(GPUMapMode.READ, 0, bytes), queryReadback?.mapAsync(GPUMapMode.READ)]);
        if (stripOptions.signal?.aborted) throw cancelled();
        if (lost) throw new Error('GPU 장치 연결이 끊겼어요.');
        const pixels = new Uint8ClampedArray(readback.getMappedRange(0, bytes).slice(0));
        let timestampMs: number | null = null;
        if (queryReadback) {
          const times = new BigUint64Array(queryReadback.getMappedRange());
          timestampMs = Number(times[1]! - times[0]!) / 1_000_000;
          if (!Number.isFinite(timestampMs) || timestampMs < 0) timestampMs = null;
        }
        return { pixels, busyMs: performance.now() - started, timestampMs };
      } catch (error) { if (stripOptions.signal?.aborted) throw cancelled(); throw error; }
      finally {
        stripOptions.signal?.removeEventListener('abort', abort);
        if (!lost) { readback.unmap(); queryReadback?.unmap(); }
        busy = false;
      }
    },
  };
}
