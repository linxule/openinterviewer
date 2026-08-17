// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateInterviewResponse,
  getInterviewGreeting,
  synthesizeInterview,
} from '@/services/interviewApi';
import { saveCompletedInterview } from '@/services/storageService';
import { makeStudyConfig } from '../fixtures/models';

const sessionHandle = 'participant-handle-a-123456';
const invalidHandle = 'short';

const history = [{ id: 'message-a', role: 'user' as const, content: 'Hello', timestamp: 1 }];
const profile = { id: 'participant-a', fields: [], rawContext: '', timestamp: 1 };
const progress = {
  questionsAsked: [] as number[],
  total: 1,
  currentPhase: 'background' as const,
  isComplete: false,
};
const behavior = {
  timePerTopic: {},
  messagesPerTopic: {},
  topicsExplored: [],
  contradictions: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function expectXorHeaders(
  headers: Record<string, string>,
  expected: 'preview' | 'participant' | 'neither',
  handle = sessionHandle,
) {
  expect(headers['Content-Type']).toBe('application/json');
  if (expected === 'preview') {
    expect(headers['X-OpenInterviewer-Preview']).toBe('1');
    expect(headers['X-OpenInterviewer-Participant-Session']).toBeUndefined();
    expect(Object.keys(headers).sort()).toEqual(['Content-Type', 'X-OpenInterviewer-Preview'].sort());
    return;
  }
  if (expected === 'participant') {
    expect(headers['X-OpenInterviewer-Participant-Session']).toBe(handle);
    expect(headers['X-OpenInterviewer-Preview']).toBeUndefined();
    expect(Object.keys(headers).sort()).toEqual(
      ['Content-Type', 'X-OpenInterviewer-Participant-Session'].sort(),
    );
    return;
  }
  expect(headers['X-OpenInterviewer-Preview']).toBeUndefined();
  expect(headers['X-OpenInterviewer-Participant-Session']).toBeUndefined();
  expect(Object.keys(headers)).toEqual(['Content-Type']);
}

function headersOf(fetchMock: ReturnType<typeof stubFetch>, index = 0) {
  return fetchMock.mock.calls[index][1].headers as Record<string, string>;
}

async function callGreeting(preview: boolean, handle?: string | null) {
  return getInterviewGreeting(makeStudyConfig(), preview, handle);
}

async function callInterview(preview: boolean, handle?: string | null) {
  return generateInterviewResponse(
    history,
    makeStudyConfig(),
    profile,
    progress,
    '',
    preview,
    handle,
  );
}

async function callSynthesis(preview: boolean, handle?: string | null) {
  return synthesizeInterview(history, makeStudyConfig(), behavior, profile, preview, handle);
}

async function callSave(preview: boolean, handle?: string | null) {
  const study = makeStudyConfig({ id: 'study-a' });
  return saveCompletedInterview({
    id: 'interview-a',
    studyId: study.id,
    studyName: study.name,
    participantProfile: profile,
    transcript: history,
    synthesis: null,
    behaviorData: behavior,
    createdAt: 1,
  }, preview, handle);
}

describe('participant and preview request headers', () => {
  it('selects the tab participant session for provider requests', async () => {
    const fetchMock = stubFetch({ greeting: 'Hello' });

    await callGreeting(false, sessionHandle);

    expect(fetchMock).toHaveBeenCalledWith('/api/greeting', expect.objectContaining({
      headers: expect.objectContaining({
        'X-OpenInterviewer-Participant-Session': sessionHandle,
      }),
    }));
    expectXorHeaders(headersOf(fetchMock), 'participant');
  });

  it('uses only the explicit researcher preview marker for preview provider requests', async () => {
    const fetchMock = stubFetch({ greeting: 'Hello' });

    await callGreeting(true, sessionHandle);

    expectXorHeaders(headersOf(fetchMock), 'preview');
  });

  it('omits greeting authority when no valid session handle is present', async () => {
    const fetchMock = stubFetch({ greeting: 'Hello' });

    await callGreeting(false, invalidHandle);

    expectXorHeaders(headersOf(fetchMock), 'neither');
  });

  it('never sends both greeting authority headers', async () => {
    const fetchMock = stubFetch({ greeting: 'Hello' });

    await callGreeting(true, sessionHandle);

    expectXorHeaders(headersOf(fetchMock), 'preview');
  });

  it('selects the participant session for interview replies', async () => {
    const fetchMock = stubFetch({
      message: 'Tell me more.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    await callInterview(false, sessionHandle);

    expect(fetchMock).toHaveBeenCalledWith('/api/interview', expect.objectContaining({
      method: 'POST',
    }));
    expectXorHeaders(headersOf(fetchMock), 'participant');
  });

  it('uses only the preview marker for interview replies', async () => {
    const fetchMock = stubFetch({
      message: 'Tell me more.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    await callInterview(true, sessionHandle);

    expectXorHeaders(headersOf(fetchMock), 'preview');
  });

  it('omits interview authority when the handle is invalid', async () => {
    const fetchMock = stubFetch({
      message: 'Tell me more.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    await callInterview(false, '   ');

    expectXorHeaders(headersOf(fetchMock), 'neither');
  });

  it('never sends both interview authority headers', async () => {
    const fetchMock = stubFetch({
      message: 'Tell me more.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    await callInterview(true, sessionHandle);

    expectXorHeaders(headersOf(fetchMock), 'preview');
  });

  it('selects the participant session for synthesis', async () => {
    const fetchMock = stubFetch({
      statedPreferences: [],
      revealedPreferences: [],
      themes: [],
      contradictions: [],
      keyInsights: [],
      bottomLine: 'ok',
    });

    await callSynthesis(false, sessionHandle);

    expect(fetchMock).toHaveBeenCalledWith('/api/synthesis', expect.objectContaining({
      method: 'POST',
    }));
    expectXorHeaders(headersOf(fetchMock), 'participant');
  });

  it('uses only the preview marker for synthesis', async () => {
    const fetchMock = stubFetch({
      statedPreferences: [],
      revealedPreferences: [],
      themes: [],
      contradictions: [],
      keyInsights: [],
      bottomLine: 'ok',
    });

    await callSynthesis(true, sessionHandle);

    expectXorHeaders(headersOf(fetchMock), 'preview');
  });

  it('omits synthesis authority when no handle is provided', async () => {
    const fetchMock = stubFetch({
      statedPreferences: [],
      revealedPreferences: [],
      themes: [],
      contradictions: [],
      keyInsights: [],
      bottomLine: 'ok',
    });

    await callSynthesis(false, null);

    expectXorHeaders(headersOf(fetchMock), 'neither');
  });

  it('never sends both synthesis authority headers', async () => {
    const fetchMock = stubFetch({
      statedPreferences: [],
      revealedPreferences: [],
      themes: [],
      contradictions: [],
      keyInsights: [],
      bottomLine: 'ok',
    });

    await callSynthesis(true, sessionHandle);

    expectXorHeaders(headersOf(fetchMock), 'preview');
  });

  it('propagates the selected participant session to completed-interview saves', async () => {
    const fetchMock = stubFetch({ success: true, id: 'interview-a' });

    await callSave(false, sessionHandle);

    expect(fetchMock).toHaveBeenCalledWith('/api/interviews/save', expect.objectContaining({
      headers: expect.objectContaining({
        'X-OpenInterviewer-Participant-Session': sessionHandle,
      }),
    }));
    expectXorHeaders(headersOf(fetchMock), 'participant');
  });

  it('uses only the preview marker for completed-interview saves', async () => {
    const fetchMock = stubFetch({ success: true, id: 'interview-a', preview: true });

    await callSave(true, sessionHandle);

    expectXorHeaders(headersOf(fetchMock), 'preview');
  });

  it('omits save authority when the handle is empty', async () => {
    const fetchMock = stubFetch({ success: true, id: 'interview-a' });

    await callSave(false, '');

    expectXorHeaders(headersOf(fetchMock), 'neither');
  });

  it('never sends both save authority headers', async () => {
    const fetchMock = stubFetch({ success: true, id: 'interview-a', preview: true });

    await callSave(true, sessionHandle);

    expectXorHeaders(headersOf(fetchMock), 'preview');
  });
});

describe('retry callsites reuse the same XOR headers', () => {
  it('greeting retry keeps the participant selector', async () => {
    const fetchMock = stubFetch({ greeting: 'Hello' });

    await callGreeting(false, sessionHandle);
    await callGreeting(false, sessionHandle);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectXorHeaders(headersOf(fetchMock, 0), 'participant');
    expectXorHeaders(headersOf(fetchMock, 1), 'participant');
  });

  it('interview retry keeps preview-only authority', async () => {
    const fetchMock = stubFetch({
      message: 'Tell me more.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [],
      shouldConclude: false,
    });

    await callInterview(true, sessionHandle);
    await callInterview(true, sessionHandle);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectXorHeaders(headersOf(fetchMock, 0), 'preview');
    expectXorHeaders(headersOf(fetchMock, 1), 'preview');
  });

  it('synthesis retry does not invent a session header', async () => {
    const fetchMock = stubFetch({
      statedPreferences: [],
      revealedPreferences: [],
      themes: [],
      contradictions: [],
      keyInsights: [],
      bottomLine: 'ok',
    });

    await callSynthesis(false, invalidHandle);
    await callSynthesis(false, invalidHandle);

    expectXorHeaders(headersOf(fetchMock, 0), 'neither');
    expectXorHeaders(headersOf(fetchMock, 1), 'neither');
  });

  it('save retry keeps the participant selector', async () => {
    const fetchMock = stubFetch({ success: true, id: 'interview-a' });

    await callSave(false, sessionHandle);
    await callSave(false, sessionHandle);

    expectXorHeaders(headersOf(fetchMock, 0), 'participant');
    expectXorHeaders(headersOf(fetchMock, 1), 'participant');
  });
});
