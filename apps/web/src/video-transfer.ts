/** Compress one frame with bounded output storage; transfer raw pixels on older browsers. */
export async function prepareVideoTransfer(pixels: ArrayBuffer, signal: AbortSignal): Promise<{ body: ArrayBuffer | Uint8Array<ArrayBuffer>; encoding?: 'gzip' }> {
  signal.throwIfAborted();
  if (typeof CompressionStream === 'undefined') return { body: pixels };
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(new Uint8Array(pixels)); controller.close(); } })
    .pipeThrough(new CompressionStream('gzip'));
  const reader = stream.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    // A single destination avoids retaining a list of compressed chunks and a second joined copy.
    const output = new Uint8Array(pixels.byteLength + 64 * 1024);
    let length = 0;
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (length + value.byteLength > output.byteLength) { await reader.cancel(); return { body: pixels }; }
      output.set(value, length); length += value.byteLength;
    }
    return length < pixels.byteLength ? { body: output.subarray(0, length), encoding: 'gzip' } : { body: pixels };
  } catch (error) {
    signal.throwIfAborted();
    await reader.cancel(error).catch(() => {});
    return { body: pixels };
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

export function waitForVideoTransferRetry(retry: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason ?? new DOMException('Transfer stopped', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, Math.min(1000, 250 * 2 ** retry) + Math.random() * 150);
    signal.addEventListener('abort', stop, { once: true });
  });
}
