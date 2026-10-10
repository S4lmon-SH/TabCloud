import type { AnimationSettings, FrameTask } from '@tabcloud/shared';

type Pixel = [number, number, number, number];
type Vec3 = [number, number, number];

export interface AnimationSphere {
  x: number; y: number; z: number; radius: number;
  r: number; g: number; b: number; reflection: number; roughness: number;
}

export interface AnimationScene {
  settings: AnimationSettings;
  spheres: AnimationSphere[];
  camera: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  light: Vec3;
  frameIndex: number;
}

type Scene = AnimationScene;

const TAU = Math.PI * 2;
const EPSILON = 0.0001;
const FIELD_OF_VIEW = Math.tan(36 * Math.PI / 360);

function assertSettings(settings: AnimationSettings, frameIndex: number): void {
  if (!Number.isInteger(settings.width) || settings.width < 64 || settings.width > 1280 || settings.width % 2
    || !Number.isInteger(settings.height) || settings.height < 64 || settings.height > 720 || settings.height % 2
    || !Number.isInteger(settings.frames) || settings.frames < 1 || settings.frames > 240
    || settings.fps !== 24
    || !Number.isInteger(settings.samples) || settings.samples < 1 || settings.samples > 32
    || !Number.isInteger(settings.bounces) || settings.bounces < 1 || settings.bounces > 4
    || !Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= settings.frames) {
    throw new RangeError('Unsupported animation settings or frame index.');
  }
}

function normalized(x: number, y: number, z: number): Vec3 {
  const scale = 1 / Math.hypot(x, y, z);
  return [x * scale, y * scale, z * scale];
}

export function prepareAnimationScene(settings: AnimationSettings, frameIndex: number): AnimationScene {
  assertSettings(settings, frameIndex);
  // Time depends on the requested frame, never on the order or speed of rendering.
  const phase = TAU * frameIndex / settings.frames;
  const cameraAngle = 0.48 + Math.sin(phase) * 0.24;
  const camera: Vec3 = [Math.sin(cameraAngle) * 7.8, 2.65 + Math.cos(phase) * 0.15, Math.cos(cameraAngle) * 7.8];
  const forward = normalized(-camera[0], 0.85 - camera[1], -camera[2]);
  const right = normalized(-forward[2], 0, forward[0]);
  const up: Vec3 = [right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  return {
    settings, camera, forward, right, up, frameIndex,
    light: [-3.5 + Math.sin(phase) * 1.8, 7, 4 + Math.cos(phase)],
    spheres: [
      { x: -0.9, y: 1.04, z: -0.3, radius: 1.04, r: 0.025, g: 0.19, b: 0.78, reflection: 0.48, roughness: 0.018 },
      { x: 1.1, y: 0.76, z: 0.1, radius: 0.76, r: 0.76, g: 0.83, b: 0.94, reflection: 0.82, roughness: 0.013 },
      { x: 0.05, y: 0.4, z: 1.55, radius: 0.4, r: 1, g: 0.36, b: 0.055, reflection: 0.5, roughness: 0.024 },
      { x: 2.65 * Math.cos(phase + 0.6), y: 0.4 + 0.15 * (1 + Math.sin(phase * 2)),
        z: -0.3 + 2.2 * Math.sin(phase + 0.6), radius: 0.32,
        r: 0.06, g: 0.78, b: 0.59, reflection: 0.3, roughness: 0.045 },
      { x: -2.05, y: 0.33, z: 0.8, radius: 0.33, r: 0.95, g: 0.17, b: 0.3, reflection: 0.22, roughness: 0.05 },
    ],
  };
}

/** Radiance from a procedural studio environment; the bright panel also reflects in the spheres. */
function environment(dx: number, dy: number, dz: number, output: Vec3): void {
  const sky = Math.max(0, Math.min(1, dy * 0.75 + 0.2));
  const panel = Math.pow(Math.max(0, -dx * 0.4 + dy * 0.65 + dz * 0.65), 36) * 2.4;
  output[0] = 0.16 * (1 - sky) + 0.018 * sky + panel;
  output[1] = 0.25 * (1 - sky) + 0.045 * sky + panel;
  output[2] = 0.4 * (1 - sky) + 0.1 * sky + panel;
}

function isShadowed(scene: Scene, x: number, y: number, z: number,
  dx: number, dy: number, dz: number, distance: number): boolean {
  for (const sphere of scene.spheres) {
    const sx = x - sphere.x;
    const sy = y - sphere.y;
    const sz = z - sphere.z;
    const halfB = sx * dx + sy * dy + sz * dz;
    const discriminant = halfB * halfB - (sx * sx + sy * sy + sz * sz - sphere.radius * sphere.radius);
    if (discriminant <= 0) continue;
    const hit = -halfB - Math.sqrt(discriminant);
    if (hit > EPSILON && hit < distance) return true;
  }
  return false;
}

// A full ray path is evaluated with scalar coordinates to keep allocations out of the bounce loop.
function trace(scene: Scene, dx: number, dy: number, dz: number, random: () => number, output: Vec3): void {
  const primaryX = dx; const primaryY = dy; const primaryZ = dz;
  let primaryDistance = 0;
  let [ox, oy, oz] = scene.camera;
  let throughputR = 1;
  let throughputG = 1;
  let throughputB = 1;
  let accumulatedR = 0;
  let accumulatedG = 0;
  let accumulatedB = 0;
  const environmentColor: Vec3 = [0, 0, 0];
  for (let bounce = 0; bounce < scene.settings.bounces; bounce += 1) {
    let closest = dy < -EPSILON ? -oy / dy : Infinity;
    if (closest <= EPSILON) closest = Infinity;
    let object = -1;
    for (let i = 0; i < scene.spheres.length; i += 1) {
      const sphere = scene.spheres[i]!;
      const sx = ox - sphere.x;
      const sy = oy - sphere.y;
      const sz = oz - sphere.z;
      const halfB = sx * dx + sy * dy + sz * dz;
      const discriminant = halfB * halfB - (sx * sx + sy * sy + sz * sz - sphere.radius * sphere.radius);
      if (discriminant <= 0) continue;
      const distance = -halfB - Math.sqrt(discriminant);
      if (distance > EPSILON && distance < closest) {
        closest = distance;
        object = i;
      }
    }
    if (!Number.isFinite(closest)) {
      environment(dx, dy, dz, environmentColor);
      accumulatedR += throughputR * environmentColor[0];
      accumulatedG += throughputG * environmentColor[1];
      accumulatedB += throughputB * environmentColor[2];
      throughputR = 0;
      break;
    }
    if (bounce === 0) primaryDistance = closest;
    const px = ox + dx * closest;
    const py = oy + dy * closest;
    const pz = oz + dz * closest;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let red: number;
    let green: number;
    let blue: number;
    let reflection: number;
    let roughness: number;
    if (object < 0) {
      const tile = (Math.floor(px * 0.85) + Math.floor(pz * 0.85)) & 1;
      red = tile ? 0.045 : 0.07;
      green = tile ? 0.06 : 0.095;
      blue = tile ? 0.09 : 0.14;
      reflection = 0.17;
      roughness = 0.025;
    } else {
      const sphere = scene.spheres[object]!;
      nx = (px - sphere.x) / sphere.radius;
      ny = (py - sphere.y) / sphere.radius;
      nz = (pz - sphere.z) / sphere.radius;
      red = sphere.r; green = sphere.g; blue = sphere.b;
      reflection = sphere.reflection; roughness = sphere.roughness;
    }

    // One area-light sample per camera sample produces genuine soft shadow convergence.
    const lightX = scene.light[0] + (random() - 0.5) * 2;
    const lightZ = scene.light[2] + (random() - 0.5) * 2;
    const lx = lightX - px;
    const ly = scene.light[1] - py;
    const lz = lightZ - pz;
    const lightDistance = Math.sqrt(lx * lx + ly * ly + lz * lz);
    const ldx = lx / lightDistance;
    const ldy = ly / lightDistance;
    const ldz = lz / lightDistance;
    let diffuse = Math.max(0, nx * ldx + ny * ldy + nz * ldz);
    const shadowed = diffuse > 0 && isShadowed(scene, px + nx * EPSILON, py + ny * EPSILON,
      pz + nz * EPSILON, ldx, ldy, ldz, lightDistance);
    if (shadowed) diffuse = 0;
    const falloff = 85 / (lightDistance * lightDistance + 20);
    const illumination = 0.16 + 0.12 * Math.max(0, ny) + diffuse * falloff;
    const facing = Math.max(0, -(dx * nx + dy * ny + dz * nz));
    reflection += (1 - reflection) * Math.pow(1 - facing, 5) * 0.8;
    const specularBase = Math.max(0, -(dx * (2 * diffuse * nx - ldx)
      + dy * (2 * diffuse * ny - ldy) + dz * (2 * diffuse * nz - ldz)));
    const specular = shadowed ? 0 : Math.pow(specularBase, 80) * falloff * 0.45;
    accumulatedR += throughputR * (red * illumination * (1 - reflection) + specular);
    accumulatedG += throughputG * (green * illumination * (1 - reflection) + specular);
    accumulatedB += throughputB * (blue * illumination * (1 - reflection) + specular);
    throughputR *= reflection * (object < 0 ? 0.95 : 0.3 + red * 0.7);
    throughputG *= reflection * (object < 0 ? 0.95 : 0.3 + green * 0.7);
    throughputB *= reflection * (object < 0 ? 0.95 : 0.3 + blue * 0.7);

    const normalDot = dx * nx + dy * ny + dz * nz;
    dx = dx - 2 * normalDot * nx + (random() - 0.5) * roughness;
    dy = dy - 2 * normalDot * ny + (random() - 0.5) * roughness;
    dz = dz - 2 * normalDot * nz + (random() - 0.5) * roughness;
    const directionLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
    dx /= directionLength; dy /= directionLength; dz /= directionLength;
    ox = px + nx * EPSILON; oy = py + ny * EPSILON; oz = pz + nz * EPSILON;
  }
  if (throughputR > 0) {
    environment(dx, dy, dz, environmentColor);
    accumulatedR += throughputR * environmentColor[0];
    accumulatedG += throughputG * environmentColor[1];
    accumulatedB += throughputB * environmentColor[2];
  }
  // Atmospheric distance fade removes the distracting infinite checkerboard horizon.
  const fog = 1 - Math.exp(-Math.max(0, primaryDistance - 14) / 35);
  environment(primaryX, primaryY, primaryZ, environmentColor);
  output[0] = accumulatedR * (1 - fog) + environmentColor[0] * fog;
  output[1] = accumulatedG * (1 - fog) + environmentColor[1] * fog;
  output[2] = accumulatedB * (1 - fog) + environmentColor[2] * fog;
}

function encodeChannel(linear: number): number {
  // Bounded, rounded, sRGB-like display transform. No browser color APIs are involved.
  const exposed = Math.max(0, linear) * 1.35;
  return Math.round(255 * Math.sqrt(exposed / (1 + exposed)));
}

function pixel(scene: Scene, x: number, y: number): Pixel {
  let seed = (Math.imul(x + 1, 1973) ^ Math.imul(y + 1, 9277) ^ Math.imul(scene.frameIndex + 1, 26699)) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const { width, height, samples } = scene.settings;
  const color: Vec3 = [0, 0, 0];
  let red = 0; let green = 0; let blue = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const horizontal = ((x + random()) / width * 2 - 1) * width / height * FIELD_OF_VIEW;
    const vertical = (1 - (y + random()) / height * 2) * FIELD_OF_VIEW;
    const dx = scene.forward[0] + scene.right[0] * horizontal + scene.up[0] * vertical;
    const dy = scene.forward[1] + scene.right[1] * horizontal + scene.up[1] * vertical;
    const dz = scene.forward[2] + scene.right[2] * horizontal + scene.up[2] * vertical;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    trace(scene, dx / length, dy / length, dz / length, random, color);
    red += color[0]; green += color[1]; blue += color[2];
  }
  return [encodeChannel(red / samples), encodeChannel(green / samples), encodeChannel(blue / samples), 255];
}

/** Independently reproducible validation pixel. Samples never depend on adjacent pixels or task order. */
export function renderAnimationPixel(settings: AnimationSettings, frameIndex: number, x: number, y: number): Pixel {
  const scene = prepareAnimationScene(settings, frameIndex);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= settings.width || y < 0 || y >= settings.height) {
    throw new RangeError('Pixel lies outside the animation frame.');
  }
  return pixel(scene, x, y);
}

/** Reuse the same prepared scene when correcting GPU pixels at floating-point boundaries. */
export function renderAnimationScenePixel(scene: AnimationScene, x: number, y: number): Pixel {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= scene.settings.width || y < 0 || y >= scene.settings.height) {
    throw new RangeError('Pixel lies outside the animation frame.');
  }
  return pixel(scene, x, y);
}

function taskScene(task: FrameTask): Scene {
  if (task.algorithmVersion !== 'raytrace-v1') throw new RangeError('Unsupported animation algorithm.');
  return prepareAnimationScene(task.settings, task.frameIndex);
}

function renderRows(scene: Scene, output: Uint8ClampedArray, start: number, end: number, outputStartRow = 0): void {
  for (let y = start; y < end; y += 1) {
    for (let x = 0; x < scene.settings.width; x += 1) {
      const rgba = pixel(scene, x, y);
      const offset = ((y - outputStartRow) * scene.settings.width + x) * 4;
      output[offset] = rgba[0]; output[offset + 1] = rgba[1]; output[offset + 2] = rgba[2]; output[offset + 3] = 255;
    }
  }
}

export function renderAnimationFrame(task: FrameTask): Uint8ClampedArray {
  const scene = taskScene(task);
  const output = new Uint8ClampedArray(task.settings.width * task.settings.height * 4);
  renderRows(scene, output, 0, task.settings.height);
  return output;
}

export interface AsyncAnimationOptions {
  onProgress?: (completedRows: number) => void;
  signal?: AbortSignal;
  rowsPerChunk?: number;
  yieldControl?: () => Promise<void>;
}

/** Cooperative full-frame renderer for a Worker. Stop/heartbeat messages run between small row chunks. */
export async function renderAnimationFrameAsync(task: FrameTask, options: AsyncAnimationOptions = {}): Promise<Uint8ClampedArray> {
  const scene = taskScene(task);
  const chunk = options.rowsPerChunk ?? 4;
  if (!Number.isInteger(chunk) || chunk < 1 || chunk > 32) throw new RangeError('Invalid rowsPerChunk.');
  const output = new Uint8ClampedArray(task.settings.width * task.settings.height * 4);
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  for (let row = 0; row < task.settings.height; row += chunk) {
    if (options.signal?.aborted) {
      const error = new Error('Animation rendering cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    const end = Math.min(row + chunk, task.settings.height);
    renderRows(scene, output, row, end);
    options.onProgress?.(end);
    if (end < task.settings.height) await yieldControl();
  }
  // A final progress callback may itself cancel the job; do not publish the completed buffer in that case.
  if (options.signal?.aborted) {
    const error = new Error('Animation rendering cancelled.');
    error.name = 'AbortError';
    throw error;
  }
  return output;
}

export interface AsyncAnimationRowsOptions extends AsyncAnimationOptions {
  /** Fraction of time this Worker may spend computing, between 0 (exclusive) and 1. */
  dutyCycle?: number;
  /** Adaptive chunk target; a single expensive row can still take longer. */
  targetChunkMs?: number;
  onActiveTime?: (chunkComputeMs: number) => void;
  /** Injectable monotonic clock and delay for deterministic budget tests. */
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Animation rendering cancelled.');
  error.name = 'AbortError';
  throw error;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const error = new Error('Animation rendering cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Render an independently schedulable row strip into a compact RGBA buffer.
 * Progress is relative to this strip; pixel seeds use absolute frame coordinates.
 * Each measured compute burst is followed by its proportional idle time, including
 * the final burst so repeatedly scheduled short strips respect the same budget.
 */
export async function renderAnimationRowsAsync(task: FrameTask, startRow: number, rowCount: number,
  options: AsyncAnimationRowsOptions = {}): Promise<Uint8ClampedArray> {
  const scene = taskScene(task);
  if (!Number.isInteger(startRow) || !Number.isInteger(rowCount) || startRow < 0 || rowCount < 1
    || startRow + rowCount > task.settings.height) throw new RangeError('Row strip lies outside the animation frame.');
  const maxChunk = options.rowsPerChunk ?? 8;
  const dutyCycle = options.dutyCycle ?? 1;
  const targetChunkMs = options.targetChunkMs ?? 8;
  if (!Number.isInteger(maxChunk) || maxChunk < 1 || maxChunk > 32) throw new RangeError('Invalid rowsPerChunk.');
  if (!Number.isFinite(dutyCycle) || dutyCycle <= 0 || dutyCycle > 1) throw new RangeError('Invalid dutyCycle.');
  if (!Number.isFinite(targetChunkMs) || targetChunkMs < 1 || targetChunkMs > 50) throw new RangeError('Invalid targetChunkMs.');
  assertNotAborted(options.signal);
  const output = new Uint8ClampedArray(task.settings.width * rowCount * 4);
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds, options.signal));
  let chunkRows = 1;
  let completed = 0;
  while (completed < rowCount) {
    assertNotAborted(options.signal);
    const count = Math.min(chunkRows, rowCount - completed);
    const started = now();
    renderRows(scene, output, startRow + completed, startRow + completed + count, startRow);
    const activeMs = Math.max(0, now() - started);
    completed += count;
    options.onActiveTime?.(activeMs);
    options.onProgress?.(completed);
    assertNotAborted(options.signal);
    // Sleep is rounded upward: timer resolution must not silently exceed a small requested budget.
    const idleMs = Math.ceil(activeMs * (1 / dutyCycle - 1));
    if (idleMs > 0) await sleep(idleMs);
    else if (completed < rowCount) await (options.yieldControl?.() ?? sleep(0));
    assertNotAborted(options.signal);
    // Limit growth to twice the preceding chunk as scene complexity changes across rows.
    chunkRows = Math.max(1, Math.min(maxChunk, chunkRows * 2, Math.floor(targetChunkMs * count / Math.max(0.1, activeMs))));
  }
  return output;
}
