import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegStatic from 'ffmpeg-static';
import { PNG } from 'pngjs';
import { VIDEO_LIMITS, type VideoSourceSnapshot } from '@tabcloud/shared';

const MIB = 1024 * 1024;
export const MAX_VIDEO_OUTPUT_BYTES = 64 * MIB;
export const SOURCE_AUDIO_BYTES = 2 * MIB;
export const frameName = (index: number) => String(index).padStart(6, '0');
export class VideoFileError extends Error { constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); } }
const invalid = (message = 'MP4·MOV·WebM 동영상을 확인해 주세요.'): never => { throw new VideoFileError(422, 'INVALID_VIDEO', message); };

interface ProcessResult { stderr: string; stdout: string }
function ffmpeg(args: string[], signal?: AbortSignal, timeoutMs = 120_000): { process: ChildProcess; completed: Promise<ProcessResult> } {
  const executable = process.env.FFMPEG_PATH || ffmpegStatic;
  if (!executable) throw new Error('FFmpeg executable is unavailable.');
  const child = spawn(executable, ['-nostdin', '-hide_banner', '-y', ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; let stdout = ''; let failure: Error | null = null;
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-65_536); });
  child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-65_536); });
  const stop = () => { failure = new Error(signal?.aborted ? 'Video preparation cancelled.' : 'Video processing timed out.'); child.kill(); };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const completed = new Promise<ProcessResult>((resolveResult, reject) => {
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (failure || code !== 0) reject(failure ?? new Error(`FFmpeg failed (${code}): ${stderr}`));
      else resolveResult({ stderr, stdout });
    });
  });
  return { process: child, completed };
}

/** Private server-generated paths only; uploaded file names never enter FFmpeg arguments. */
export class VideoFiles {
  private constructor(readonly root: string) {}
  static async create() { return new VideoFiles(await mkdtemp(join(tmpdir(), 'tabcloud-video-'))); }
  async createDirectory(id: string) { const directory = join(this.root, id); await mkdir(directory); return directory; }

  async receive(directory: string, input: Readable, signal: AbortSignal): Promise<{ bytes: number; format: 'mov' | 'matroska' }> {
    let bytes = 0; let prefix = Buffer.alloc(0);
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > VIDEO_LIMITS.maxUploadBytes) { callback(new VideoFileError(413, 'VIDEO_TOO_LARGE', '64 MiB 이하 동영상을 선택해 주세요.')); return; }
      if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
      callback(null, chunk);
    } });
    await pipeline(input, bounded, createWriteStream(join(directory, 'upload.bin'), { flags: 'wx' }), { signal });
    if (bytes < 12) invalid();
    const format = prefix.subarray(4, 8).toString('ascii') === 'ftyp' ? 'mov'
      : prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'matroska' : invalid();
    return { bytes, format };
  }

  async prepare(directory: string, format: 'mov' | 'matroska', sourceBytes: number, signal: AbortSignal,
    reserve: (bytes: number) => void): Promise<Omit<VideoSourceSnapshot, 'id' | 'status' | 'failureReason'>> {
    const input = ['-protocol_whitelist', 'file,pipe', '-f', format,
      ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-threads', '2', '-i', join(directory, 'upload.bin')];
    let probe: ProcessResult;
    try { probe = await ffmpeg([...input, '-map', '0:v:0', '-frames:v', '0', '-an', '-sn', '-dn', '-f', 'null', '-'], signal, 30_000).completed; }
    catch { return invalid('읽을 수 있는 동영상 트랙이 없어요. MP4·MOV·WebM 파일을 확인해 주세요.'); }
    if (signal.aborted) throw new Error('Video preparation cancelled.');
    const durationMatch = probe.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const duration = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : null;
    if (duration !== null && (duration <= 0 || duration > VIDEO_LIMITS.maxDurationSeconds + 0.001)) invalid('30초 이하 동영상만 사용할 수 있어요.');
    const videoLine = probe.stderr.split('\n').find((line) => /Stream.*Video:/.test(line));
    const dimensions = videoLine?.match(/(?:^|[,\s])(\d{1,6})x(\d{1,6})(?:[,\s[]|$)/);
    const width = Number(dimensions?.[1]); const height = Number(dimensions?.[2]);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 4096 || height > 4096 || width * height > 16_777_216) invalid('입력 해상도는 각 변 4096픽셀 이하인 동영상으로 선택해 주세요.');
    const scaledPixels = (w: number, h: number) => { const scale = Math.min(1, 1280 / w, 720 / h); return Math.max(2, Math.ceil(w * scale / 2) * 2) * Math.max(2, Math.ceil(h * scale / 2) * 2); };
    const maximumPixels = Math.max(scaledPixels(width, height), scaledPixels(height, width));
    const maximumFrames = duration === null ? VIDEO_LIMITS.maxFrames + 1 : Math.min(VIDEO_LIMITS.maxFrames + 1, Math.ceil(duration * 24) + 2);
    const rgbaCeiling = maximumPixels * maximumFrames * 4;
    reserve(sourceBytes + rgbaCeiling + VIDEO_LIMITS.maxFrameBytes + SOURCE_AUDIO_BYTES);
    const rgbaPath = join(directory, 'source.rgba');
    let decoded: ProcessResult;
    try {
      decoded = await ffmpeg([...input, '-map', '0:v:0', '-an', '-sn', '-dn', '-t', '31', '-frames:v', '721',
        '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=24",
        '-pix_fmt', 'rgba', '-threads', '2', '-filter_threads', '1', '-fs', String(rgbaCeiling), '-f', 'rawvideo', rgbaPath], signal).completed;
    } catch { return invalid('동영상 프레임을 준비하지 못했어요. 다른 파일을 선택해 주세요.'); }
    if (signal.aborted) throw new Error('Video preparation cancelled.');
    const outputLog = decoded.stderr.split(/Output #0,/).at(-1)!;
    const normalized = outputLog.match(/Video:\s*rawvideo[^\n]*?[,\s](\d+)x(\d+)(?:[,\s[]|$)/);
    const normalizedWidth = Number(normalized?.[1]); const normalizedHeight = Number(normalized?.[2]);
    const rgbaBytes = (await stat(rgbaPath)).size;
    const frameBytes = normalizedWidth * normalizedHeight * 4;
    const frames = rgbaBytes / frameBytes;
    if (!Number.isInteger(normalizedWidth) || !Number.isInteger(normalizedHeight) || normalizedWidth < 2 || normalizedHeight < 2
      || normalizedWidth > 1280 || normalizedHeight > 720 || normalizedWidth % 2 || normalizedHeight % 2
      || !Number.isInteger(frames) || frames < 1 || frames > VIDEO_LIMITS.maxFrames || rgbaBytes >= rgbaCeiling) invalid('30초 이하의 정상적인 동영상만 사용할 수 있어요.');
    let hasAudio = /Stream.*Audio:/.test(probe.stderr);
    let audioBytes = 0;
    if (hasAudio) {
      try {
        await ffmpeg([...input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(frames / 24), '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
          '-threads', '2', '-fs', String(SOURCE_AUDIO_BYTES), '-movflags', '+faststart', join(directory, 'audio.m4a')], signal, 60_000).completed;
        audioBytes = (await stat(join(directory, 'audio.m4a'))).size;
        if (audioBytes >= SOURCE_AUDIO_BYTES) invalid('오디오 크기 제한을 초과했어요.');
        hasAudio = audioBytes > 256;
      } catch { return invalid('원본 오디오를 준비하지 못했어요. 오디오 트랙을 확인해 주세요.'); }
    }
    await rm(join(directory, 'upload.bin'), { force: true });
    reserve(rgbaBytes + audioBytes);
    return { width: normalizedWidth, height: normalizedHeight, frames, fps: 24, durationSeconds: frames / 24, sourceBytes, hasAudio };
  }

  async sourceFrame(directory: string, index: number, width: number, height: number): Promise<Buffer> {
    const frameBytes = width * height * 4; const output = Buffer.allocUnsafe(frameBytes);
    const file = await open(join(directory, 'source.rgba'), 'r');
    try { const result = await file.read(output, 0, frameBytes, index * frameBytes); if (result.bytesRead !== frameBytes) throw new Error('Source frame is incomplete.'); }
    finally { await file.close(); }
    return output;
  }

  async prepareFrame(directory: string, index: number, attemptId: string, width: number, height: number, rgba: Buffer) {
    const name = frameName(index); const temporary = join(directory, `${name}.${attemptId}.ppm.tmp`);
    const rgb = Buffer.allocUnsafe(width * height * 3);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
      rgb[target] = rgba[source]!; rgb[target + 1] = rgba[source + 1]!; rgb[target + 2] = rgba[source + 2]!;
    }
    const discard = () => rm(temporary, { force: true });
    try { await writeFile(temporary, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb])); }
    catch (error) { await discard(); throw error; }
    return { discard, commit: () => rename(temporary, join(directory, `${name}.ppm`)) };
  }

  encode(directory: string, sourceDirectory: string, frames: number, hasAudio: boolean) {
    const encoded = ffmpeg(['-loglevel', 'error', '-framerate', '24', '-start_number', '0', '-i', join(directory, '%06d.ppm'),
      ...(hasAudio ? ['-i', join(sourceDirectory, 'audio.m4a')] : []), '-map', '0:v:0', ...(hasAudio ? ['-map', '1:a:0', '-c:a', 'copy'] : []),
      '-frames:v', String(frames), '-t', String(frames / 24), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-threads', '2',
      '-fs', String(MAX_VIDEO_OUTPUT_BYTES), '-progress', 'pipe:1', '-movflags', '+faststart', join(directory, 'video.mp4')]);
    return { process: encoded.process, completed: encoded.completed.then(async ({ stdout }) => {
      const lastFrame = [...stdout.matchAll(/^frame=(\d+)/gm)].at(-1)?.[1];
      if (Number(lastFrame) !== frames || (await stat(join(directory, 'video.mp4'))).size >= MAX_VIDEO_OUTPUT_BYTES) throw new Error('Encoded video exceeded its output budget.');
    }) };
  }

  thumbnail(rgba: Buffer, width: number, height: number): Buffer {
    const scale = Math.min(1, 320 / width, 180 / height); const w = Math.max(1, Math.round(width * scale)); const h = Math.max(1, Math.round(height * scale));
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const offset = (Math.min(height - 1, Math.floor(y / scale)) * width + Math.min(width - 1, Math.floor(x / scale))) * 4;
      rgba.copy(png.data, (y * w + x) * 4, offset, offset + 4);
    }
    return PNG.sync.write(png);
  }
  async preview(directory: string, index: number, width: number, height: number): Promise<Buffer> {
    const rgb = await readFile(join(directory, `${frameName(index)}.ppm`)); const body = rgb.subarray(rgb.length - width * height * 3);
    const rgba = Buffer.allocUnsafe(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) { rgba[pixel * 4] = body[pixel * 3]!; rgba[pixel * 4 + 1] = body[pixel * 3 + 1]!; rgba[pixel * 4 + 2] = body[pixel * 3 + 2]!; rgba[pixel * 4 + 3] = 255; }
    return this.thumbnail(rgba, width, height);
  }
  video(directory: string) { return createReadStream(join(directory, 'video.mp4')); }
  async removeDirectory(directory: string) {
    const child = relative(resolve(this.root), resolve(directory));
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Refusing to remove a path outside the video root.');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  async close() { await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
