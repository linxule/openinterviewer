import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeInterview, getInterviewAnalysisStatus, startInterviewAnalysisV2 } from '@/services/analysisApi';

afterEach(() => vi.unstubAllGlobals());

describe('researcher analysis response boundary', () => {
  it('preserves a recorded provider failure as a successful request outcome', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'failed', failureKind: 'provider', error: 'Private upstream details',
    })));
    vi.stubGlobal('fetch', fetchMock);

    expect(await analyzeInterview('interview/id', 'study id')).toEqual({
      ok: true, outcome: { status: 'failed', failureKind: 'provider' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/interviews/interview%2Fid/analyze?studyId=study%20id',
      { method: 'POST' },
    );
  });

  it.each([
    {},
    { status: 'unavailable' },
    { status: 'failed' },
    { status: 'failed', failureKind: 'Private upstream details' },
  ])('refuses an unrecognized 200 response without forwarding its contents: %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));

    expect(await analyzeInterview('interview-1', 'study-1')).toEqual({
      ok: false,
      kind: 'request',
      error: 'The analysis result could not be confirmed. Reload the page before trying again.',
    });
  });

  it('preserves the pending-operation classification without forwarding server error text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'STUDY_OPERATION_PENDING', error: 'Private server details',
    }), { status: 409 })));

    expect(await analyzeInterview('interview-1', 'study-1')).toEqual({
      ok: false,
      kind: 'pending',
      error: 'A study operation is already in progress. Try again after it finishes.',
    });
  });
});

describe('legacy analysis against a durable server (API-01)', () => {
  it('API-01: maps ANALYSIS_CLIENT_UPDATE_REQUIRED to a reload instruction without server text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'ANALYSIS_CLIENT_UPDATE_REQUIRED', error: 'Private server details',
    }), { status: 409 })));

    expect(await analyzeInterview('interview-1', 'study-1')).toEqual({
      ok: false,
      kind: 'update-required',
      error: 'Reload this page to analyze interviews.',
    });
  });
});

const KEY = '0b7c7f38-3f5c-4d0e-9a57-5b2d1c1f7a10';

function startV2(overrides: Partial<Parameters<typeof startInterviewAnalysisV2>[0]> = {}) {
  return startInterviewAnalysisV2({
    studyId: 'study 1',
    interviewId: 'interview/1',
    expectedGeneration: 2,
    idempotencyKey: KEY,
    ...overrides,
  });
}

describe('durable analysis start (API-01)', () => {
  it('API-01: sends the version header, the action key and only the expected generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'pending', generation: 3, phase: 'queued', pollAfterMs: 2000,
    }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await startV2()).toEqual({
      ok: true, outcome: { status: 'pending', generation: 3, phase: 'queued', pollAfterMs: 2000 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/interviews/interview%2F1/analyze?studyId=study%201');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-OpenInterviewer-Analysis-Version': '2',
      'Idempotency-Key': KEY,
    });
    expect(JSON.parse(init.body as string)).toEqual({ expectedGeneration: 2 });
  });

  it.each([
    [{ expectedGeneration: -1 }],
    [{ expectedGeneration: 1.5 }],
    [{ idempotencyKey: 'not-a-uuid' }],
  ])('API-01: refuses to send an invalid action %j', async (overrides) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await startV2(overrides);
    expect(result).toMatchObject({ ok: false, kind: 'request', uncertain: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'complete', generation: 3 }, { status: 'complete', generation: 3 }],
    [{ status: 'already-complete', generation: 2 }, { status: 'already-complete', generation: 2 }],
    [
      { status: 'failed', generation: 3, failureKind: 'provider', recoveryRequired: false, error: 'Private' },
      { status: 'failed', generation: 3, failureKind: 'provider', recoveryRequired: false },
    ],
    [
      { status: 'failed', generation: 3, failureKind: 'timeout', recoveryRequired: true },
      { status: 'failed', generation: 3, failureKind: 'timeout', recoveryRequired: true },
    ],
    [
      { status: 'pending', generation: 4, phase: 'running', claimToken: 'secret', jobId: 'job' },
      { status: 'pending', generation: 4, phase: 'running' },
    ],
  ])('API-02: parses the closed projection %j and nothing else', async (body, outcome) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));

    expect(await startV2()).toEqual({ ok: true, outcome });
  });

  it.each([
    {},
    { status: 'complete' },
    { status: 'busy' },
    { status: 'pending', generation: 3, phase: 'not-scheduled' },
    { status: 'pending', generation: 0, phase: 'queued' },
    { status: 'pending', generation: 3, phase: 'paused' },
    { status: 'failed', generation: 3, failureKind: 'provider' },
    { status: 'failed', generation: 3, failureKind: 'Private upstream details', recoveryRequired: false },
    { status: 'complete', generation: -1 },
    { status: 'complete', generation: '3' },
  ])('API-02: a malformed 2xx %j could not be confirmed and is retried with the same action', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));

    expect(await startV2()).toEqual({
      ok: false,
      kind: 'unconfirmed',
      uncertain: true,
      error: 'The analysis result could not be confirmed. Reload the page before trying again.',
    });
  });

  it.each<[number, Record<string, unknown>, string, boolean, string]>([
    [409, { code: 'ANALYSIS_CLIENT_UPDATE_REQUIRED' }, 'update-required', false, 'Reload this page to analyze interviews.'],
    [409, { code: 'ANALYSIS_STATE_CHANGED' }, 'state-changed', false, 'This interview’s analysis changed since the page loaded. Check its latest status before running it again.'],
    [409, { code: 'ANALYSIS_REQUEST_KEY_CONFLICT' }, 'key-conflict', false, 'This analysis request could not be matched to the earlier attempt. Reload the page before trying again.'],
    [409, { code: 'STUDY_OPERATION_PENDING' }, 'pending', false, 'A study operation is already in progress. Try again after it finishes.'],
    [404, {}, 'not-found', false, 'This interview could not be found. It may have been deleted.'],
    [401, {}, 'unauthorized', false, 'Analysis could not be authorized. Reload the page and sign in if needed.'],
    [403, {}, 'unauthorized', false, 'Analysis could not be authorized. Reload the page and sign in if needed.'],
    [429, {}, 'rate-limited', false, 'The analysis request limit has been reached. Wait before trying again.'],
    [503, { retryable: true }, 'unavailable', true, 'Analysis is temporarily unavailable. Please try again.'],
    // A 503 naming a workspace hold is a certain refusal (nothing was allocated).
    [503, { retryable: true, reason: 'maintenance' }, 'held', false, 'Analysis is paused while this workspace is under maintenance. Nothing was started; try again later.'],
    [503, { retryable: false, reason: 'workspace-unavailable' }, 'held', false, 'Analysis is unavailable because this workspace is unavailable. Nothing was started; its operator must restore it.'],
    [503, { retryable: false, reason: 'not-configured' }, 'held', false, 'Analysis is unavailable because this workspace is unavailable. Nothing was started; its operator must restore it.'],
    // An unrecognized reason stays uncertain: the same key is retried.
    [503, { retryable: true, reason: 'something-else' }, 'unavailable', true, 'Analysis is temporarily unavailable. Please try again.'],
    [500, {}, 'request', true, 'The analysis request could not be completed. Please try again.'],
    [400, {}, 'request', false, 'The analysis request could not be completed. Please try again.'],
  ])('API-01: HTTP %s %j → %s (uncertain: %s) without server text', async (status, body, kind, uncertain, error) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...body, error: 'Private server details',
    }), { status })));

    const result = await startV2();
    expect(result).toEqual({ ok: false, kind, uncertain, error });
    expect(JSON.stringify(result)).not.toContain('Private');
  });

  it('API-01: a lost response is uncertain, so the same action is retried rather than refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    expect(await startV2()).toEqual({
      ok: false,
      kind: 'network',
      uncertain: true,
      error: 'The analysis request could not reach the server. Check your connection and try again.',
    });
  });
});

describe('durable analysis status read (API-02)', () => {
  it('API-02: reads with GET on the same URL, uncached, with no key or body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'pending', generation: 0, phase: 'not-scheduled',
    })));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getInterviewAnalysisStatus({ studyId: 'study 1', interviewId: 'interview/1' })).toEqual({
      ok: true, outcome: { status: 'pending', generation: 0, phase: 'not-scheduled' },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/interviews/interview%2F1/analyze?studyId=study%201');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' });
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it.each<[number, string]>([
    [503, 'unavailable'],
    [500, 'request'],
    [429, 'rate-limited'],
    [404, 'not-found'],
    [401, 'unauthorized'],
  ])('API-02: a failed read (HTTP %s → %s) is never uncertain and carries read-specific copy', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Private' }), { status })));

    const result = await getInterviewAnalysisStatus({ studyId: 's', interviewId: 'i' });
    expect(result).toMatchObject({ ok: false, kind, uncertain: false });
    expect(result.ok ? '' : result.error).not.toContain('Private');
  });

  it('API-02: a read with a malformed body could not be confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>')));

    expect(await getInterviewAnalysisStatus({ studyId: 's', interviewId: 'i' })).toEqual({
      ok: false, kind: 'unconfirmed', uncertain: false, error: 'The analysis status could not be confirmed. Try again.',
    });
  });
});
