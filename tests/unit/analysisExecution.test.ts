import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecutionModule = typeof import('@/services/analysisExecution');

// The capability is cached per page load, i.e. per module instance.
async function freshModule(): Promise<ExecutionModule> {
  vi.resetModules();
  return import('@/services/analysisExecution');
}

function readiness(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('analysis execution capability (RT-08, UI-CF-03)', () => {
  it.each<[unknown, string]>([
    [{ mode: 'standalone', ready: true, analysisExecution: 'queued-v2' }, 'queued-v2'],
    [{ mode: 'standalone', ready: true, analysisExecution: 'synchronous' }, 'synchronous'],
    [{ mode: 'standalone', ready: true }, 'synchronous'],
    [{ mode: null, ready: false, analysisExecution: null }, 'synchronous'],
    [{ ready: false, analysisExecution: 'queued-v3' }, 'unknown'],
    [['queued-v2'], 'unknown'],
    [null, 'unknown'],
  ])('UI-CF-03: readiness %j selects %s; only an explicit queued-v2 selects the durable protocol', async (body, mode) => {
    const { parseAnalysisExecution } = await freshModule();
    expect(parseAnalysisExecution(body)).toBe(mode);
  });

  it('RT-08: an older deployment that omits the field is the legacy synchronous path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(readiness({ mode: 'standalone', ready: true, errors: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { loadAnalysisExecution } = await freshModule();

    expect(await loadAnalysisExecution()).toBe('synchronous');
    expect(fetchMock).toHaveBeenCalledWith('/api/config/readiness', expect.objectContaining({ cache: 'no-store' }));
  });

  it('UI-CF-03: a confirmed answer is read once per page load, including concurrent callers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(readiness({ analysisExecution: 'queued-v2' }));
    vi.stubGlobal('fetch', fetchMock);
    const { loadAnalysisExecution } = await freshModule();

    const [first, second] = await Promise.all([loadAnalysisExecution(), loadAnalysisExecution()]);
    expect([first, second, await loadAnalysisExecution()]).toEqual(['queued-v2', 'queued-v2', 'queued-v2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => Promise<Response>]>([
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a server error', () => Promise.resolve(new Response('{}', { status: 500 }))],
    ['an unreadable body', () => Promise.resolve(new Response('<html>', { status: 200 }))],
  ])('UI-CF-03: %s is unknown and is asked again on next use rather than cached', async (_label, first) => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(first)
      .mockResolvedValueOnce(readiness({ analysisExecution: 'queued-v2' }));
    vi.stubGlobal('fetch', fetchMock);
    const { loadAnalysisExecution } = await freshModule();

    expect(await loadAnalysisExecution()).toBe('unknown');
    expect(await loadAnalysisExecution()).toBe('queued-v2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('UI-CF-03: a readiness request that never answers ends as unknown after a bounded wait', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { loadAnalysisExecution } = await freshModule();

    const pending = loadAnalysisExecution();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe('unknown');
  });
});
