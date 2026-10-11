import { describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { prepareVideoTransfer, waitForVideoTransferRetry } from './video-transfer';

describe('video frame transfer', () => {
  it('compresses pixels losslessly without allocating an unbounded chunk list', async () => {
    const pixels = new Uint8Array(160 * 90 * 4).fill(123);
    const result = await prepareVideoTransfer(pixels.buffer, new AbortController().signal);
    expect(result.encoding).toBe('gzip');
    expect(result.body.byteLength).toBeLessThan(pixels.byteLength);
    expect(gunzipSync(new Uint8Array(result.body instanceof ArrayBuffer ? result.body : result.body.buffer, result.body instanceof ArrayBuffer ? 0 : result.body.byteOffset, result.body.byteLength))).toEqual(Buffer.from(pixels));
  });

  it('uses raw bytes if compression does not reduce transfer size', async () => {
    const pixels = Uint8Array.from(randomBytes(65_536));
    const result = await prepareVideoTransfer(pixels.buffer, new AbortController().signal);
    expect(result.encoding).toBeUndefined();
    expect(result.body).toBe(pixels.buffer);
  });

  it('works when CompressionStream is unavailable', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    try {
      const pixels = new ArrayBuffer(16);
      expect(await prepareVideoTransfer(pixels, new AbortController().signal)).toEqual({ body: pixels });
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects aborted work before starting compression', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareVideoTransfer(new ArrayBuffer(16), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('interrupts a pending capacity retry when consent is revoked', async () => {
    const controller = new AbortController();
    const pending = waitForVideoTransferRetry(5, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops compression already in progress when consent is revoked', async () => {
    const controller = new AbortController();
    const pending = prepareVideoTransfer(new ArrayBuffer(8 * 1024 * 1024), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
