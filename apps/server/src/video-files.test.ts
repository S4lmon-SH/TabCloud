import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import ffmpegStatic from 'ffmpeg-static';
import { DEFAULT_VIDEO_OUTPUT, VIDEO_LIMITS, getVideoFrameWindow, type VideoOutputSettings, type VideoSourceSnapshot } from '@tabcloud/shared';
import { VideoFiles, type VideoPipeline } from './video-files.js';

const executable = process.env.FFMPEG_PATH || ffmpegStatic!;
const stores: VideoFiles[] = []; const pipelines: VideoPipeline[] = [];
afterEach(async () => { await Promise.all(pipelines.splice(0).map((value) => value.close())); await Promise.all(stores.splice(0).map((value) => value.close())); });
function run(args: string[], input?: Buffer) {
  const result = spawnSync(executable, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, input, maxBuffer: 64 * 1024 * 1024 });
  expect(result.status, result.stderr.toString()).toBe(0); return result;
}
function clip({ fps = '60', duration = 1.1, size = '64x64', format = 'mp4', audio = false, filter = '', extra = [] as string[] } = {}) {
  const codec = format === 'avi' ? 'mpeg4' : format === 'mpeg' ? 'mpeg2video' : format === 'flv' ? 'flv1' : format === 'webm' ? 'libvpx-vp9' : 'libx264';
  return run(['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}`, ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
    '-t', String(duration), ...(filter ? ['-vf', filter] : []), '-c:v', codec, '-threads', '1', '-pix_fmt', 'yuv420p',
    ...(audio ? ['-c:a', 'aac'] : []), ...extra, ...(format === 'mp4' ? ['-movflags', 'frag_keyframe+empty_moov'] : []), '-f', format, 'pipe:1']).stdout;
}
async function fixture(bytes: Buffer) {
  const files = await VideoFiles.create(); stores.push(files);
  const sourceDirectory = await files.createDirectory('source'); const controller = new AbortController();
  const received = await files.receive(sourceDirectory, Readable.from([bytes]), controller.signal);
  const reservations: number[] = [];
  const metadata = await files.prepare(sourceDirectory, received.format, received.bytes, controller.signal, (value) => { reservations.push(value); });
  const source: VideoSourceSnapshot = { id: 'source', status: 'ready', failureReason: null, ...metadata };
  const start = async (output: VideoOutputSettings = DEFAULT_VIDEO_OUTPUT) => {
    const directory = await files.createDirectory(`job-${pipelines.length}`);
    const worker = files.startPipeline(directory, sourceDirectory, source, output, controller.signal); pipelines.push(worker);
    return { worker, directory };
  };
  return { files, sourceDirectory, source, start, controller, reservations };
}
async function processAll(f: Awaited<ReturnType<typeof fixture>>, output: VideoOutputSettings = DEFAULT_VIDEO_OUTPUT) {
  const { worker, directory } = await f.start(output); let start = 0; let windows = 0;
  for (;;) {
    const window = await worker.readWindow(start);
    expect(window.end - start).toBeLessThanOrEqual(24);
    expect(window.end - start).toBeLessThanOrEqual(getVideoFrameWindow(worker.width, worker.height));
    expect((window.end - start) * worker.width * worker.height * 7).toBeLessThanOrEqual(VIDEO_LIMITS.rawWindowBytes);
    expect((await readdir(directory)).filter((name) => name.endsWith('.rgba'))).toHaveLength(window.end - start);
    if (window.end > start) {
      for (let frame = start; frame < window.end; frame += 1) {
        const input = await f.files.sourceFrame(directory, frame, worker.width, worker.height);
        const prepared = await f.files.prepareFrame(directory, frame, 'attempt', worker.width, worker.height, input);
        await prepared.commit(); await prepared.discard();
      }
      await worker.encodeWindow(start, window.end); windows += 1;
      expect((await readdir(directory)).some((name) => /\.(rgba|ppm)$/.test(name))).toBe(false);
    }
    start = window.end;
    if (window.eof) break;
  }
  await worker.finalize(start); await worker.close();
  expect((await readdir(directory)).some((name) => name.startsWith('segment-'))).toBe(false);
  return { directory, frames: start, windows, worker, video: await readFile(join(directory, 'video.mp4')) };
}

describe('bounded high quality uploaded video files', () => {
  it('processes 60fps through several bounded windows, evicts raw frames and retains audio in final MP4', async () => {
    const f = await fixture(clip({ audio: true }));
    expect(f.source.fps).toBe(60); expect(f.source.hasAudio).toBe(true);
    expect((await readdir(f.sourceDirectory)).sort()).toEqual(['audio.m4a', 'preview.png', 'upload.bin']);
    expect(Math.max(...f.reservations)).toBeLessThan(10 * 1024 * 1024);
    const result = await processAll(f);
    expect(result.frames).toBe(66); expect(result.windows).toBe(3);
    const decoded = run(['-i', 'pipe:0', '-an', '-pix_fmt', 'rgba', '-threads', '1', '-f', 'rawvideo', 'pipe:1'], result.video);
    expect(decoded.stdout.length).toBe(66 * 64 * 64 * 4);
    expect(run(['-i', 'pipe:0', '-map', '0:a:0', '-f', 'null', '-'], result.video).status).toBe(0);
    expect((await f.files.preview(result.directory, 0)).subarray(1, 4).toString()).toBe('PNG');
  }, 20_000);

  it('keeps compressed source storage bounded for videos longer than 30 seconds', async () => {
    const f = await fixture(clip({ duration: 35, fps: '1', size: '32x32' }));
    expect(f.source.durationSeconds).toBeGreaterThan(30);
    const result = await processAll(f);
    expect(result.frames).toBe(35); expect(result.windows).toBe(2);
    expect((await stat(join(f.sourceDirectory, 'upload.bin'))).size).toBeLessThan(1024 * 1024);
  }, 15_000);

  it('keeps 1080p60 windows below 64 MiB throughout decoding and encoding', async () => {
    const f = await fixture(clip({ size: '1920x1080', fps: '60', duration: 0.5,
      extra: ['-preset', 'ultrafast', '-tune', 'zerolatency'] }));
    const result = await processAll(f);
    expect(result.frames).toBe(30); expect(result.windows).toBe(8);
    expect([result.worker.width, result.worker.height, result.worker.fps]).toEqual([1920, 1080, 60]);
  }, 30_000);

  it('preserves fractional frame rates exactly across output segment boundaries', async () => {
    const f = await fixture(clip({ fps: '30000/1001', duration: 1.2 }));
    expect(f.source.fps).toBeCloseTo(30000 / 1001, 8);
    const result = await processAll(f);
    expect(result.frames).toBe(36); expect(result.windows).toBe(2);
    const probe = spawnSync(executable, ['-hide_banner', '-i', 'pipe:0', '-frames:v', '1', '-vf', 'showinfo', '-f', 'null', '-'], { input: result.video, windowsHide: true });
    expect(probe.status, probe.stderr.toString()).toBe(0);
    expect(probe.stderr.toString()).toContain('frame_rate: 30000/1001');
  }, 15_000);

  it('preserves portrait and square-pixel display aspect without upscaling', async () => {
    const portrait = await fixture(clip({ size: '72x128', fps: '24', duration: 0.1 }));
    expect(portrait.source).toMatchObject({ width: 72, height: 128, originalWidth: 72, originalHeight: 128 });
    const processed = await processAll(portrait);
    expect([processed.worker.width, processed.worker.height]).toEqual([72, 128]);
    const anamorphic = await fixture(clip({ size: '64x64', fps: '24', duration: 0.1, filter: 'setsar=2/1' }));
    expect(anamorphic.source).toMatchObject({ width: 128, height: 64, originalWidth: 64, originalHeight: 64 });
    expect((await processAll(anamorphic)).worker.width).toBe(128);
  }, 15_000);

  it('applies camera rotation and scales a real 4K source to full HD', async () => {
    const rotated = run(['-display_rotation', '90', '-i', 'pipe:0', '-map', '0:v:0', '-c', 'copy',
      '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], clip({ size: '64x96', fps: '24', duration: 0.1 })).stdout;
    const camera = await fixture(rotated);
    expect(camera.source).toMatchObject({ width: 96, height: 64, originalWidth: 64, originalHeight: 96 });
    const highResolution = await fixture(clip({ size: '3840x2160', fps: '1', duration: 0.1 }));
    expect(highResolution.source).toMatchObject({ width: 3840, height: 2160 });
    const fullHd = await processAll(highResolution);
    expect([fullHd.worker.width, fullHd.worker.height, fullHd.frames]).toEqual([1920, 1080, 1]);
  }, 20_000);

  it('finishes exactly at a complete window boundary and allows explicit frame rate conversion', async () => {
    const complete = await fixture(clip({ duration: 0.4 }));
    const result = await processAll(complete);
    expect(result.frames).toBe(24); expect(result.windows).toBe(1);
    const converted = await processAll(complete, { resolution: '720p', fps: 30, quality: 'compact' });
    expect(converted.frames).toBe(12); expect(converted.worker.fps).toBe(30);
  }, 15_000);

  it.each(['matroska', 'webm', 'avi', 'mpegts', 'mpeg', 'flv'])('accepts actual %s videos using a forced allowlisted demuxer', async (format) => {
    const f = await fixture(clip({ format, duration: 0.12, fps: '25' }));
    expect(f.source.width).toBe(64);
    expect(f.source.container).toBe(format === 'webm' ? 'matroska' : format);
    expect((await processAll(f)).frames).toBeGreaterThan(0);
  }, 15_000);

  it('rejects overlong and HDR videos explicitly', async () => {
    await expect(fixture(clip({ duration: 120.5, fps: '2', size: '32x32' }))).rejects.toThrow('120초');
    await expect(fixture(clip({ duration: 0.1, fps: '24',
      extra: ['-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc'] }))).rejects.toThrow('HDR');
  });

  it('cancels a decoder paused by window backpressure and releases file handles', async () => {
    const f = await fixture(clip({ duration: 2 })); const { worker, directory } = await f.start();
    expect(await worker.readWindow(0)).toMatchObject({ start: 0, end: 24, eof: false });
    f.controller.abort(); await worker.close(); await worker.close();
    await expect(worker.readWindow(24)).rejects.toThrow();
    await f.files.removeDirectory(directory);
    expect(await readdir(f.files.root)).toEqual(['source']);
  }, 10_000);
});
