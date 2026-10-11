import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVideoGpuProcessor, probeVideoGpu } from './video-gpu';

afterEach(() => vi.unstubAllGlobals());

describe('hardware video GPU capability checks', () => {
  it('reports unsupported browsers without starting work', async () => {
    vi.stubGlobal('navigator', {});
    expect((await probeVideoGpu()).available).toBe(false);
    expect(await createVideoGpuProcessor()).toBeNull();
  });
  it('probes a real adapter without creating a device before participation consent', async () => {
    const requestDevice = vi.fn();
    const requestAdapter = vi.fn(async () => ({ info: { vendor: 'nvidia', architecture: 'ampere', isFallbackAdapter: false }, requestDevice }));
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    expect(await probeVideoGpu()).toEqual({ available: true, adapterName: 'nvidia · ampere', reason: null });
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
    expect(requestDevice).not.toHaveBeenCalled();
  });
  it.each([
    { vendor: 'nvidia', architecture: 'ampere', isFallbackAdapter: true },
    { vendor: 'microsoft', description: 'Microsoft Basic Render Driver', isFallbackAdapter: false },
    { vendor: 'google', description: 'SwiftShader Device', isFallbackAdapter: false },
  ])('rejects software adapters instead of counting their CPU work as GPU work: %j', async (info) => {
    const requestDevice = vi.fn();
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ info, requestDevice }) } });
    expect((await probeVideoGpu()).available).toBe(false);
    await expect(createVideoGpuProcessor()).rejects.toThrow('소프트웨어 GPU');
    expect(requestDevice).not.toHaveBeenCalled();
  });
  it('declines an unidentified adapter when hardware status cannot be verified', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ info: {} }) } });
    expect((await probeVideoGpu()).available).toBe(false);
    await expect(createVideoGpuProcessor()).rejects.toThrow('실제 GPU');
  });
  it('does not request an adapter after cancellation', async () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const controller = new AbortController(); controller.abort();
    await expect(createVideoGpuProcessor({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestAdapter).not.toHaveBeenCalled();
  });
});
