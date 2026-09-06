import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeInterview } from '@/services/analysisApi';

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
