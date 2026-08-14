// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getInterviewGreeting } from '@/services/geminiService';
import { saveCompletedInterview } from '@/services/storageService';
import { makeStudyConfig } from '../fixtures/models';

const sessionHandle = 'participant-handle-a-123456';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('participant and preview request headers', () => {
  it('selects the tab participant session for provider requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ greeting: 'Hello' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getInterviewGreeting(makeStudyConfig(), null, false, sessionHandle);

    expect(fetchMock).toHaveBeenCalledWith('/api/greeting', expect.objectContaining({
      headers: expect.objectContaining({
        'X-OpenInterviewer-Participant-Session': sessionHandle,
      }),
    }));
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-OpenInterviewer-Preview']).toBeUndefined();
  });

  it('uses only the explicit researcher preview marker for preview provider requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ greeting: 'Hello' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getInterviewGreeting(makeStudyConfig(), null, true, sessionHandle);

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-OpenInterviewer-Preview']).toBe('1');
    expect(headers['X-OpenInterviewer-Participant-Session']).toBeUndefined();
  });

  it('propagates the selected participant session to completed-interview saves', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, id: 'interview-a' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const study = makeStudyConfig({ id: 'study-a' });
    await saveCompletedInterview({
      id: 'interview-a',
      studyId: study.id,
      studyName: study.name,
      participantProfile: {
        id: 'participant-a',
        fields: [],
        rawContext: '',
        timestamp: 1,
      },
      transcript: [{ id: 'message-a', role: 'user', content: 'Hello', timestamp: 1 }],
      synthesis: null,
      behaviorData: {
        timePerTopic: {},
        messagesPerTopic: {},
        topicsExplored: [],
        contradictions: [],
      },
      createdAt: 1,
    }, null, false, sessionHandle);

    expect(fetchMock).toHaveBeenCalledWith('/api/interviews/save', expect.objectContaining({
      headers: expect.objectContaining({
        'X-OpenInterviewer-Participant-Session': sessionHandle,
      }),
    }));
  });
});
