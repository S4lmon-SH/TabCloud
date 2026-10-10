import { prepareAnimationScene, renderAnimationScenePixel } from '@tabcloud/compute';
import type { AnimationScene } from '@tabcloud/compute';
import type { FrameTask } from '@tabcloud/shared';
import { animationShader } from './gpu-shader';

const UNIFORM_BYTES = 352;
export const GPU_MAX_STRIP_ROWS = 16;

export interface GpuStripResult {
  pixels: Uint8ClampedArray;
  /** Submission, completion, readback and numerical correction wall time; not OS GPU utilization. */
  busyMs: number;
  correctedPixels: number;
}

export interface GpuRenderer {
  readonly label: string;
  readonly isFallbackAdapter: boolean;
  readonly lost: boolean;
  renderStrip(task: FrameTask, rowStart: number, rowCount: number, options?: { signal?: AbortSignal }): Promise<GpuStripResult>;
  destroy(): void;
}

function cancelled(): Error {
  const error = new Error('GPU rendering cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Upload JS-computed scene geometry so CPU/GPU do not independently approximate animated trigonometry. */
export function packGpuScene(scene: AnimationScene, rowStart: number, rowCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(UNIFORM_BYTES);
  const integers = new Uint32Array(buffer);
  const floats = new Float32Array(buffer);
  integers.set([scene.settings.width, scene.settings.height, scene.settings.frames, scene.frameIndex,
    scene.settings.samples, scene.settings.bounces, rowStart, rowCount]);
  [scene.camera, scene.forward, scene.right, scene.up, scene.light].forEach((vector, index) => floats.set(vector, 8 + index * 4));
  scene.spheres.forEach((sphere, index) => {
    const offset = 28 + index * 12;
    floats.set([sphere.x, sphere.y, sphere.z, sphere.radius,
      sphere.r, sphere.g, sphere.b, sphere.reflection, sphere.roughness, 0, 0, 0], offset);
  });
  return buffer;
}

/**
 * Call only after GPU use is explicitly enabled. Unsupported/blocked adapters return null.
 * One bounded strip is ever queued. GPU loss, abort and destroy discard incomplete output.
 */
export async function createGpuRenderer(options: { signal?: AbortSignal } = {}): Promise<GpuRenderer | null> {
  if (options.signal?.aborted) throw cancelled();
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  let adapter: GPUAdapter | null;
  try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); }
  catch { return null; }
  if (options.signal?.aborted) throw cancelled();
  if (!adapter) return null;
  let device: GPUDevice;
  try { device = await adapter.requestDevice(); }
  catch { return null; }
  let isLost = false;
  let inFlight = false;
  let currentTask = '';
  let frameCorrections = 0;
  const destroy = () => { isLost = true; device.destroy(); };
  void device.lost.then(() => { isLost = true; });
  const abortInitialization = () => destroy();
  options.signal?.addEventListener('abort', abortInitialization, { once: true });
  let pipeline: GPUComputePipeline;
  try {
    if (options.signal?.aborted) throw cancelled();
    pipeline = await device.createComputePipelineAsync({
      layout: 'auto', compute: { module: device.createShaderModule({ code: animationShader }), entryPoint: 'main' },
    });
    if (options.signal?.aborted) throw cancelled();
  } catch (error) {
    destroy();
    if (options.signal?.aborted) throw cancelled();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortInitialization);
  }
  const info = adapter.info;
  const label = info.description || info.device || info.architecture || info.vendor || 'WebGPU';
  const isFallbackAdapter = Boolean(Reflect.get(info, 'isFallbackAdapter') || Reflect.get(adapter, 'isFallbackAdapter')
    || /swiftshader|llvmpipe|software|warp/i.test([info.description, info.device, info.architecture, info.vendor].join(' ')));
  return {
    label,
    isFallbackAdapter,
    get lost() { return isLost; },
    destroy,
    async renderStrip(task, rowStart, rowCount, stripOptions = {}) {
      if (stripOptions.signal?.aborted) throw cancelled();
      if (isLost) throw new Error('GPU device was lost.');
      if (inFlight) throw new Error('A GPU strip is already in progress.');
      if (task.algorithmVersion !== 'raytrace-v1') throw new RangeError('Unsupported animation algorithm.');
      if (!Number.isInteger(rowStart) || !Number.isInteger(rowCount) || rowStart < 0 || rowCount < 1
        || rowCount > GPU_MAX_STRIP_ROWS || rowStart + rowCount > task.settings.height) {
        throw new RangeError('Invalid GPU strip bounds.');
      }
      const scene = prepareAnimationScene(task.settings, task.frameIndex);
      const count = task.settings.width * rowCount;
      const bytes = count * 8;
      inFlight = true;
      const buffers: GPUBuffer[] = [];
      const abort = () => destroy();
      stripOptions.signal?.addEventListener('abort', abort, { once: true });
      const started = performance.now();
      try {
        const uniform = device.createBuffer({ size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        buffers.push(uniform);
        const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        buffers.push(output);
        const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        buffers.push(readback);
        device.queue.writeBuffer(uniform, 0, packGpuScene(scene, rowStart, rowCount));
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: output } },
        ] });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        if (stripOptions.signal?.aborted) throw cancelled();
        if (isLost) throw new Error('GPU device was lost.');
        const mapped = new Uint32Array(readback.getMappedRange());
        const pixels = new Uint8ClampedArray(count * 4);
        let correctedPixels = 0;
        for (let index = 0; index < count; index += 1) if (mapped[index * 2 + 1]) correctedPixels += 1;
        // Corrections concentrate near the horizon and object edges, so bound total frame work
        // instead of rejecting a legitimate strip with many edge pixels. Never silently render
        // most of a GPU frame on the CPU when its floating point implementation is unsuitable.
        const taskKey = `${task.jobId}:${task.taskId}:${task.frameIndex}`;
        if (currentTask !== taskKey) { currentTask = taskKey; frameCorrections = 0; }
        frameCorrections += correctedPixels;
        if (frameCorrections > task.settings.width * task.settings.height * 0.4) {
          throw new Error('GPU numerical precision is insufficient for this frame.');
        }
        let correctionsSinceYield = 0;
        let lastYield = performance.now();
        for (let index = 0; index < count; index += 1) {
          if (mapped[index * 2 + 1]) {
            pixels.set(renderAnimationScenePixel(scene, index % task.settings.width,
              rowStart + Math.floor(index / task.settings.width)), index * 4);
            correctionsSinceYield += 1;
            if (correctionsSinceYield >= 32) {
              correctionsSinceYield = 0;
              if (performance.now() - lastYield >= 4) {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                lastYield = performance.now();
                if (stripOptions.signal?.aborted) throw cancelled();
                if (isLost) throw new Error('GPU device was lost.');
              }
            }
          } else {
            const packed = mapped[index * 2]!;
            pixels[index * 4] = packed & 255;
            pixels[index * 4 + 1] = (packed >>> 8) & 255;
            pixels[index * 4 + 2] = (packed >>> 16) & 255;
            pixels[index * 4 + 3] = 255;
          }
        }
        readback.unmap();
        if (stripOptions.signal?.aborted) throw cancelled();
        return { pixels, busyMs: performance.now() - started, correctedPixels };
      } catch (error) {
        if (stripOptions.signal?.aborted) throw cancelled();
        throw error;
      } finally {
        stripOptions.signal?.removeEventListener('abort', abort);
        for (const buffer of buffers) buffer.destroy();
        inFlight = false;
      }
    },
  };
}
