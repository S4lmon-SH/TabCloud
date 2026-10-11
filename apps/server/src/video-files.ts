import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegStatic from 'ffmpeg-static';
import { PNG } from 'pngjs';
import { VIDEO_LIMITS, getVideoFrameWindow, resolveVideoOutput, type VideoOutputSettings, type VideoSourceSnapshot } from '@tabcloud/shared';

const MIB = 1024 * 1024;
export const MAX_VIDEO_OUTPUT_BYTES = 512 * MIB;
export const MAX_VIDEO_THUMBNAIL_BYTES = 32 * 1024;
export const SOURCE_AUDIO_BYTES = 8 * MIB;
export const frameName = (index: number) => String(index).padStart(6, '0');
export class VideoFileError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
const invalid = (message = '지원하는 정상적인 동영상 파일을 선택해 주세요.'): never => { throw new VideoFileError(422, 'INVALID_VIDEO', message); };
export type VideoInputFormat = 'mov' | 'matroska' | 'avi' | 'mpegts' | 'mpeg' | 'flv';
interface ProcessResult { stderr: string; stdout: string }

/** Every argument is built from trusted settings and private server-generated paths. */
function ffmpeg(args: string[], signal?: AbortSignal, timeoutMs = 120_000, binaryOutput = false) {
  const executable = process.env.FFMPEG_PATH || ffmpegStatic;
  if (!executable) throw new Error('FFmpeg executable is unavailable.');
  const child = spawn(executable, ['-nostdin', '-hide_banner', '-y', ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; let stdout = ''; let failure: Error | null = null;
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65_536); });
  if (!binaryOutput) child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-65_536); });
  const stop = () => { failure = new Error(signal?.aborted ? 'Video processing cancelled.' : 'Video processing timed out.'); child.kill(); };
  const timer = timeoutMs > 0 ? setTimeout(stop, timeoutMs) : null;
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const completed = new Promise<ProcessResult>((resolveResult, reject) => {
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (failure || code !== 0) reject(failure ?? new Error(`FFmpeg failed (${code}): ${stderr}`));
      else resolveResult({ stderr, stdout });
    });
  });
  // A paused decoder can fail before the next readWindow request observes it.
  void completed.catch(() => {});
  return { process: child, completed };
}

function inputArgs(directory: string, format: VideoInputFormat) {
  return ['-protocol_whitelist', 'file,pipe', '-f', format,
    ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    '-threads', '2', '-i', join(directory, 'upload.bin')];
}
function detectFormat(prefix: Buffer): VideoInputFormat {
  if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(prefix.subarray(4, 8).toString('ascii'))) return 'mov';
  if (prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'matroska';
  if (prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'AVI ') return 'avi';
  if (prefix.subarray(0, 3).toString('ascii') === 'FLV') return 'flv';
  if (prefix.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0xba]))) return 'mpeg';
  if ([188, 192, 204].some((stride) => [0, 4].some((offset) => prefix.length > offset + stride * 2
    && prefix[offset] === 0x47 && prefix[offset + stride] === 0x47 && prefix[offset + stride * 2] === 0x47))) return 'mpegts';
  return invalid('MP4·MOV·M4V·WebM·MKV·AVI·TS·MPEG·FLV 동영상을 확인해 주세요.');
}
function rationalFps(value: number): string {
  for (const numerator of [24_000, 30_000, 60_000]) if (Math.abs(value - numerator / 1001) < 0.00001) return `${numerator}/1001`;
  return String(value);
}
function durationFromLog(stderr: string): number | null {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}
function lastProgressFrame(stdout: string): number { return Number([...stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1] ?? 0); }

/** One sequential decoder, one bounded frame window, and compressed output segments. */
export class VideoPipeline {
  private readonly controller = new AbortController();
  private readonly decoder: ReturnType<typeof ffmpeg>;
  private readonly chunks: AsyncIterator<Buffer>;
  private remainder: Buffer = Buffer.alloc(0);
  private exhausted = false;
  private nextFrame = 0;
  private encodedFrames = 0;
  private segmentBytes = 0;
  private readonly segments: string[] = [];
  private operation: Promise<unknown> | null = null;
  private stopped = false;
  private readonly abortExternal: () => void;
  readonly width: number;
  readonly height: number;
  readonly fps: number;

  constructor(private readonly directory: string, private readonly sourceDirectory: string,
    source: VideoSourceSnapshot, private readonly output: VideoOutputSettings, private readonly signal: AbortSignal) {
    const resolved = resolveVideoOutput(source, output);
    this.width = resolved.width; this.height = resolved.height; this.fps = resolved.fps;
    const format = source.container as VideoInputFormat;
    if (!['mov', 'matroska', 'avi', 'mpegts', 'mpeg', 'flv'].includes(format)) invalid();
    this.abortExternal = () => this.stop();
    signal.addEventListener('abort', this.abortExternal, { once: true });
    this.decoder = ffmpeg([...inputArgs(sourceDirectory, format), '-map', '0:v:0', '-an', '-sn', '-dn',
      '-t', String(VIDEO_LIMITS.maxDurationSeconds + 1), '-frames:v', String(this.maximumFrames + 1),
      '-vf', `setpts=PTS-STARTPTS,scale=${this.width}:${this.height},setsar=1,fps=${rationalFps(this.fps)}`,
      '-pix_fmt', 'rgba', '-threads', '2', '-filter_threads', '1', '-f', 'rawvideo', 'pipe:1'], this.controller.signal, 0, true);
    this.chunks = this.decoder.process.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    if (signal.aborted) this.stop();
  }

  private get maximumFrames() { return Math.min(VIDEO_LIMITS.maxFrames, Math.ceil(VIDEO_LIMITS.maxDurationSeconds * this.fps)); }
  private assertActive() { if (this.stopped || this.signal.aborted) throw new Error('Video processing cancelled.'); }
  private async readFrame(): Promise<Buffer | null> {
    this.assertActive();
    if (this.exhausted) return null;
    const frame = Buffer.allocUnsafe(this.width * this.height * 4); let offset = 0;
    while (offset < frame.length) {
      this.assertActive();
      if (!this.remainder.length) {
        const next = await this.chunks.next();
        if (next.done) {
          await this.decoder.completed; this.exhausted = true;
          if (offset !== 0) invalid('동영상 프레임이 중간에 끊겼어요.');
          return null;
        }
        this.remainder = next.value;
      }
      const count = Math.min(this.remainder.length, frame.length - offset);
      this.remainder.copy(frame, offset, 0, count); offset += count; this.remainder = this.remainder.subarray(count);
    }
    if (this.nextFrame >= this.maximumFrames) invalid('120초 이하 동영상만 사용할 수 있어요.');
    return frame;
  }

  readWindow(start: number): Promise<{ start: number; end: number; eof: boolean }> {
    if (this.operation || start !== this.nextFrame || start !== this.encodedFrames) return Promise.reject(new Error('Frame windows must be processed in order.'));
    const operation = (async () => {
      const timer = setTimeout(() => this.stop(), 120_000);
      try {
        for (let count = 0; count < getVideoFrameWindow(this.width, this.height); count += 1) {
          const pixels = await this.readFrame();
          if (!pixels) break;
          await writeFile(join(this.directory, `${frameName(this.nextFrame)}.rgba`), pixels, { flag: 'wx' });
          this.nextFrame += 1;
        }
        return { start, end: this.nextFrame, eof: this.exhausted };
      } finally { clearTimeout(timer); }
    })();
    this.operation = operation;
    return operation.finally(() => { if (this.operation === operation) this.operation = null; });
  }

  encodeWindow(start: number, end: number): Promise<void> {
    if (this.operation || start !== this.encodedFrames || end !== this.nextFrame || end <= start) return Promise.reject(new Error('Invalid output frame window.'));
    const operation = (async () => {
      this.assertActive();
      const name = `segment-${frameName(start)}.mp4`; const path = join(this.directory, name);
      const remaining = MAX_VIDEO_OUTPUT_BYTES - this.segmentBytes;
      if (remaining <= 1024) invalid('완성 영상이 512 MiB를 넘어요. 화질을 낮춰 다시 시도해 주세요.');
      const encoded = await ffmpeg(['-loglevel', 'error', '-framerate', rationalFps(this.fps), '-start_number', String(start),
        '-thread_queue_size', '1', '-threads', '1', '-i', join(this.directory, '%06d.ppm'), '-frames:v', String(end - start), '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String({ high: 18, balanced: 20, compact: 24 }[this.output.quality]),
        '-tune', 'zerolatency', '-x264-params', 'rc-lookahead=0:sync-lookahead=0',
        '-pix_fmt', 'yuv420p', '-threads', '1', '-filter_threads', '1', '-bf', '0', '-g', String(getVideoFrameWindow(this.width, this.height)),
        '-video_track_timescale', '90000', '-fs', String(remaining), '-progress', 'pipe:1', '-movflags', '+faststart', path], this.controller.signal, 180_000).completed;
      const bytes = (await stat(path)).size;
      if (lastProgressFrame(encoded.stdout) !== end - start || bytes >= remaining) invalid('완성 영상이 512 MiB를 넘어요. 화질을 낮춰 다시 시도해 주세요.');
      this.assertActive(); this.segmentBytes += bytes; this.segments.push(name); this.encodedFrames = end;
      // No next window is decoded until both raw sources and raw results are evicted.
      for (let index = start; index < end; index += 1) {
        await rm(join(this.directory, `${frameName(index)}.rgba`));
        await rm(join(this.directory, `${frameName(index)}.ppm`));
      }
    })();
    this.operation = operation;
    return operation.finally(() => { if (this.operation === operation) this.operation = null; });
  }

  finalize(frames: number): Promise<void> {
    if (this.operation || !this.exhausted || frames < 1 || frames !== this.encodedFrames) return Promise.reject(new Error('Cannot finalize an incomplete video.'));
    const operation = (async () => {
      this.assertActive();
      const list = join(this.directory, 'segments.txt');
      await writeFile(list, this.segments.map((name) => `file '${name}'`).join('\n') + '\n');
      const hasAudio = await stat(join(this.sourceDirectory, 'audio.m4a')).then(() => true, () => false);
      const path = join(this.directory, 'video.mp4');
      await ffmpeg(['-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', list,
        ...(hasAudio ? ['-protocol_whitelist', 'file,pipe', '-i', join(this.sourceDirectory, 'audio.m4a')] : []),
        '-map', '0:v:0', ...(hasAudio ? ['-map', '1:a:0'] : []), '-c', 'copy', '-t', String(frames / this.fps),
        '-fs', String(MAX_VIDEO_OUTPUT_BYTES), '-progress', 'pipe:1', '-movflags', '+faststart', path], this.controller.signal, 120_000).completed;
      if ((await stat(path)).size >= MAX_VIDEO_OUTPUT_BYTES) invalid('완성 영상이 512 MiB를 넘어요. 화질을 낮춰 다시 시도해 주세요.');
      // Stream-copy progress has no frame field. Decode to the null sink to verify
      // the completed file instead of treating a successful mux as completeness.
      const verified = await ffmpeg(['-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', path,
        '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', String(frames + 1), '-fps_mode', 'passthrough',
        '-threads', '2', '-filter_threads', '1', '-progress', 'pipe:1', '-f', 'null', '-'], this.controller.signal, 180_000).completed;
      if (lastProgressFrame(verified.stdout) !== frames) invalid('영상이 끝까지 저장되지 않았어요. 다시 시도해 주세요.');
      this.assertActive();
      for (const name of this.segments) await rm(join(this.directory, name));
      await rm(list);
    })();
    this.operation = operation;
    return operation.finally(() => { if (this.operation === operation) this.operation = null; });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true; this.controller.abort(); this.decoder?.process.kill();
    // Windows does not emit child.close until a paused stdout pipe is released.
    this.decoder?.process.stdout.destroy();
    this.signal.removeEventListener('abort', this.abortExternal);
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([this.decoder.completed, ...(this.operation ? [this.operation] : [])]);
    this.remainder = Buffer.alloc(0);
  }
}

export class VideoFiles {
  private constructor(readonly root: string) {}
  static async create() { return new VideoFiles(await mkdtemp(join(tmpdir(), 'tabcloud-video-'))); }
  async createDirectory(id: string) { const directory = join(this.root, id); await mkdir(directory); return directory; }
  async receive(directory: string, input: Readable, signal: AbortSignal): Promise<{ bytes: number; format: VideoInputFormat }> {
    let bytes = 0; let prefix = Buffer.alloc(0);
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > VIDEO_LIMITS.maxUploadBytes) { callback(new VideoFileError(413, 'VIDEO_TOO_LARGE', '256 MiB 이하 동영상을 선택해 주세요.')); return; }
      if (prefix.length < 1024) prefix = Buffer.concat([prefix, chunk.subarray(0, 1024 - prefix.length)]);
      callback(null, chunk);
    } });
    await pipeline(input, bounded, createWriteStream(join(directory, 'upload.bin'), { flags: 'wx' }), { signal });
    if (bytes < 12) invalid();
    return { bytes, format: detectFormat(prefix) };
  }

  async prepare(directory: string, format: VideoInputFormat, sourceBytes: number, signal: AbortSignal,
    reserve: (bytes: number) => void): Promise<Omit<VideoSourceSnapshot, 'id' | 'status' | 'failureReason'>> {
    reserve(sourceBytes + SOURCE_AUDIO_BYTES + MAX_VIDEO_THUMBNAIL_BYTES);
    const input = inputArgs(directory, format);
    let probe: ProcessResult;
    try { probe = await ffmpeg([...input, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', 'showinfo', '-filter_threads', '1', '-f', 'null', '-'], signal, 45_000).completed; }
    catch { return invalid('읽을 수 있는 동영상 트랙이 없어요. 파일을 확인해 주세요.'); }
    if (signal.aborted) throw new Error('Video preparation cancelled.');
    if (/smpte2084|arib-std-b67|bt2020/i.test(probe.stderr)) invalid('HDR·광색역 영상은 아직 지원하지 않아요. SDR 영상으로 변환해 주세요.');
    const videoLine = probe.stderr.split('\n').find((line) => /Stream.*Video:/.test(line));
    const dimensions = videoLine?.match(/(?:^|[,\s])(\d{1,6})x(\d{1,6})(?:[,\s[]|$)/);
    const originalWidth = Number(dimensions?.[1]); const originalHeight = Number(dimensions?.[2]);
    if (!Number.isInteger(originalWidth) || !Number.isInteger(originalHeight) || originalWidth < 2 || originalHeight < 2
      || originalWidth > 4096 || originalHeight > 4096 || originalWidth * originalHeight > 4096 * 2160) invalid('입력 해상도는 4K·각 변 4096픽셀 이하로 선택해 주세요.');
    const display = probe.stderr.match(/\bn:\s*0\b[^\n]*\bsar:(\d+)\/(\d+)[^\n]*\bs:(\d+)x(\d+)/);
    const sar = display && Number(display[1]) > 0 && Number(display[2]) > 0 ? Number(display[1]) / Number(display[2]) : 1;
    const width = Math.round(Number(display?.[3] ?? originalWidth) * sar); const height = Number(display?.[4] ?? originalHeight);
    if (!Number.isFinite(sar) || sar <= 0 || width < 2 || width > 8192 || height > 8192 || width * height > 33_554_432) invalid('영상의 화면 비율을 확인해 주세요.');
    const rate = probe.stderr.match(/config in time_base:[^\n]*frame_rate:\s*(\d+)\/(\d+)/);
    const originalFps = rate && Number(rate[2]) ? Number(rate[1]) / Number(rate[2]) : Number(videoLine?.match(/([\d.]+) fps/)?.[1] ?? 30);
    if (!Number.isFinite(originalFps) || originalFps <= 0 || originalFps > 1000) invalid('영상의 프레임 정보를 확인해 주세요.');
    const fps = Math.min(VIDEO_LIMITS.maxFps, originalFps);
    let duration = durationFromLog(probe.stderr); let frameCountExact = false; let frames: number;
    if (duration !== null && (duration <= 0 || duration > VIDEO_LIMITS.maxDurationSeconds + 0.001)) invalid('120초 이하 동영상만 사용할 수 있어요.');
    if (duration === null) {
      const count = await ffmpeg([...input, '-map', '0:v:0', '-an', '-sn', '-dn', '-t', String(VIDEO_LIMITS.maxDurationSeconds + 1),
        '-frames:v', String(Math.ceil(VIDEO_LIMITS.maxDurationSeconds * fps) + 1), '-vf', `setpts=PTS-STARTPTS,fps=${rationalFps(fps)}`,
        '-threads', '2', '-filter_threads', '1', '-progress', 'pipe:1', '-f', 'null', '-'], signal, 180_000).completed;
      frames = lastProgressFrame(count.stdout); duration = frames / fps; frameCountExact = true;
      if (frames < 1 || frames > Math.ceil(VIDEO_LIMITS.maxDurationSeconds * fps)) invalid('120초 이하 동영상만 사용할 수 있어요.');
    } else frames = Math.max(1, Math.ceil(duration * fps));
    const thumbScale = Math.min(1, 96 / width, 54 / height);
    const thumbWidth = Math.max(1, Math.floor(width * thumbScale)); const thumbHeight = Math.max(1, Math.floor(height * thumbScale));
    await ffmpeg([...input, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', `scale=${thumbWidth}:${thumbHeight},setsar=1`,
      '-threads', '1', '-filter_threads', '1', '-update', '1', join(directory, 'preview.png')], signal, 45_000).completed;
    if ((await stat(join(directory, 'preview.png'))).size > MAX_VIDEO_THUMBNAIL_BYTES) invalid();
    let hasAudio = /Stream.*Audio:/.test(probe.stderr); let audioBytes = 0;
    if (hasAudio) {
      try {
        await ffmpeg([...input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(duration), '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
          '-threads', '2', '-fs', String(SOURCE_AUDIO_BYTES), '-movflags', '+faststart', join(directory, 'audio.m4a')], signal, 120_000).completed;
        audioBytes = (await stat(join(directory, 'audio.m4a'))).size;
        if (audioBytes >= SOURCE_AUDIO_BYTES) invalid('오디오 크기 제한을 초과했어요.');
        hasAudio = audioBytes > 256;
      } catch { return invalid('원본 오디오를 준비하지 못했어요. 오디오 트랙을 확인해 주세요.'); }
    }
    if (signal.aborted) throw new Error('Video preparation cancelled.');
    reserve(sourceBytes + audioBytes + MAX_VIDEO_THUMBNAIL_BYTES);
    return { width, height, frames, fps, durationSeconds: duration, sourceBytes, hasAudio, originalWidth, originalHeight,
      originalFps, container: format, videoCodec: videoLine?.match(/Video:\s*([^\s,(]+)/)?.[1] ?? 'unknown', frameCountExact };
  }

  startPipeline(directory: string, sourceDirectory: string, source: VideoSourceSnapshot, output: VideoOutputSettings, signal: AbortSignal) {
    return new VideoPipeline(directory, sourceDirectory, source, output, signal);
  }
  async sourceFrame(directory: string, index: number, width: number, height: number): Promise<Buffer> {
    const pixels = await readFile(join(directory, `${frameName(index)}.rgba`));
    if (pixels.length !== width * height * 4) throw new Error('Source frame is incomplete.');
    return pixels;
  }
  async prepareFrame(directory: string, index: number, attemptId: string, width: number, height: number, rgba: Buffer) {
    const name = frameName(index); const temporary = join(directory, `${name}.${attemptId}.ppm.tmp`);
    const previewTemporary = join(directory, `${name}.${attemptId}.png.tmp`);
    const rgb = Buffer.allocUnsafe(width * height * 3);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
      rgb[target] = rgba[source]!; rgb[target + 1] = rgba[source + 1]!; rgb[target + 2] = rgba[source + 2]!;
    }
    const discard = async () => { await Promise.all([rm(temporary, { force: true }), rm(previewTemporary, { force: true })]); };
    try {
      await writeFile(temporary, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
      await writeFile(previewTemporary, this.thumbnail(rgba, width, height));
    } catch (error) { await discard(); throw error; }
    return { discard, commit: async () => { await rename(temporary, join(directory, `${name}.ppm`)); await rename(previewTemporary, join(directory, `${name}.png`)); } };
  }
  thumbnail(rgba: Buffer, width: number, height: number): Buffer {
    const scale = Math.min(1, 96 / width, 54 / height); const w = Math.max(1, Math.floor(width * scale)); const h = Math.max(1, Math.floor(height * scale));
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const offset = (Math.min(height - 1, Math.floor(y / scale)) * width + Math.min(width - 1, Math.floor(x / scale))) * 4;
      rgba.copy(png.data, (y * w + x) * 4, offset, offset + 4);
    }
    const output = PNG.sync.write(png);
    if (output.length > MAX_VIDEO_THUMBNAIL_BYTES) throw new Error('Thumbnail exceeded its storage budget.');
    return output;
  }
  preview(directory: string, index: number, _width?: number, _height?: number): Promise<Buffer> { return readFile(join(directory, `${frameName(index)}.png`)); }
  sourcePreview(directory: string): Promise<Buffer> { return readFile(join(directory, 'preview.png')); }
  video(directory: string) { return createReadStream(join(directory, 'video.mp4')); }
  async removeDirectory(directory: string) {
    const child = relative(resolve(this.root), resolve(directory));
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Refusing to remove a path outside the video root.');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  async close() { await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
