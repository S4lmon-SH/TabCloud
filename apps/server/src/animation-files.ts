import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { PNG } from 'pngjs';

export const frameName = (frameIndex: number): string => String(frameIndex).padStart(6, '0');

/** Each server gets a private temporary root. No paths come from uploaded filenames. */
export class AnimationFiles {
  private constructor(readonly root: string) {}

  static async create(): Promise<AnimationFiles> {
    return new AnimationFiles(await mkdtemp(join(tmpdir(), 'tabcloud-animation-')));
  }

  async createJob(jobId: string): Promise<string> {
    const directory = join(this.root, jobId);
    await mkdir(directory);
    return directory;
  }

  async prepareFrame(directory: string, frameIndex: number, attemptId: string, width: number, height: number, rgba: Buffer): Promise<{ commit: () => Promise<void>; discard: () => Promise<void> }> {
    const name = frameName(frameIndex);
    const temporaryPpm = join(directory, `${name}.${attemptId}.ppm.tmp`);
    const temporaryPng = join(directory, `${name}.${attemptId}.png.tmp`);
    const rgb = Buffer.allocUnsafe(width * height * 3);
    for (let source = 0, destination = 0; source < rgba.length; source += 4, destination += 3) {
      rgb[destination] = rgba[source]!;
      rgb[destination + 1] = rgba[source + 1]!;
      rgb[destination + 2] = rgba[source + 2]!;
    }
    const scale = Math.min(1, 320 / width, 180 / height);
    const thumbWidth = Math.max(1, Math.round(width * scale));
    const thumbHeight = Math.max(1, Math.round(height * scale));
    const thumbnail = new PNG({ width: thumbWidth, height: thumbHeight });
    for (let y = 0; y < thumbHeight; y += 1) {
      for (let x = 0; x < thumbWidth; x += 1) {
        const source = (Math.min(height - 1, Math.floor(y * height / thumbHeight)) * width + Math.min(width - 1, Math.floor(x * width / thumbWidth))) * 4;
        rgba.copy(thumbnail.data, (y * thumbWidth + x) * 4, source, source + 4);
      }
    }
    const discard = async () => { await Promise.all([rm(temporaryPpm, { force: true }), rm(temporaryPng, { force: true })]); };
    try {
      await Promise.all([
        writeFile(temporaryPpm, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb])),
        writeFile(temporaryPng, PNG.sync.write(thumbnail)),
      ]);
    } catch (error) {
      await discard();
      throw error;
    }
    return {
      discard,
      commit: async () => {
        await rename(temporaryPpm, join(directory, `${name}.ppm`));
        await rename(temporaryPng, join(directory, `${name}.png`));
      },
    };
  }

  encode(directory: string, frames: number, fps: number): { process: ChildProcess; completed: Promise<void> } {
    const executable = process.env.FFMPEG_PATH || ffmpegStatic;
    if (!executable) throw new Error('FFmpeg executable is unavailable.');
    const child = spawn(executable, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', String(fps), '-start_number', '0', '-i', join(directory, '%06d.ppm'),
      '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-pix_fmt', 'yuv420p', '-threads', '2', '-movflags', '+faststart', join(directory, 'animation.mp4'),
    ], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr?.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
    const completed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Video encoding failed (${code}): ${diagnostic}`)));
    });
    return { process: child, completed };
  }

  preview(directory: string, frameIndex: number) { return createReadStream(join(directory, `${frameName(frameIndex)}.png`)); }
  video(directory: string) { return createReadStream(join(directory, 'animation.mp4')); }
  async removeJob(directory: string): Promise<void> {
    const child = relative(resolve(this.root), resolve(directory));
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Refusing to remove a path outside the animation root.');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  async close(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }
}
