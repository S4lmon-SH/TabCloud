import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const requireServer = createRequire(resolve('apps/server/package.json'));
const ffmpeg = process.env.FFMPEG_PATH || requireServer('ffmpeg-static') as string;

/** Generated test media only. Production processing always starts with a user upload. */
export function makeVideoFixture(directory: string, frames = 12, width = 160, height = 96, fps = 24): string {
  const path = join(directory, 'uploaded-with-audio.mp4');
  const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(frames / fps), '-vf', 'noise=alls=12:allf=t',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-threads', '2', '-filter_threads', '1', '-movflags', '+faststart', path],
  { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  if (encoded.status !== 0) throw new Error(`Test fixture failed: ${encoded.stderr}`);
  return path;
}

export function checkVideoAudio(path: string): { nonSilent: boolean; samples: number } {
  const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path,
    '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'],
  { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (decoded.status !== 0) throw new Error(`Output audio failed: ${decoded.stderr.toString()}`);
  let peak = 0;
  for (let offset = 0; offset + 1 < decoded.stdout.length; offset += 2) peak = Math.max(peak, Math.abs(decoded.stdout.readInt16LE(offset)));
  return { nonSilent: peak > 100, samples: decoded.stdout.length / 2 };
}
