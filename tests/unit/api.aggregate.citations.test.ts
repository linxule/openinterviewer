// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';
import { GEMINI_SYNTHESIS_MODEL } from '@/types';
import { withRecordBackedEvidence } from '@/lib/evidence';

// All quotes and transcripts below are invented fixture content, never real
// participant text (AGENTS.md "Start here" §5).

const contextMock = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getAuthorizedResearcherStudyContext: vi.fn(),
  providerKeysFromContext: vi.fn((context: Record<string, unknown>) => ({
    geminiApiKey: context.geminiApiKey,
    anthropicApiKey: context.anthropicApiKey,
    openaiApiKey: context.openaiApiKey,
    openrouterApiKey: context.openrouterApiKey,
  })),
}));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  getStudy: vi.fn(),
  getStudyChecked: vi.fn(),
  getStudyInterviewsChecked: vi.fn(),
  saveStudyAggregate: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

const synthesizeAggregate = vi.hoisted(() => vi.fn());
const getInterviewProvider = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers')>();
  return {
    ...actual,
    getInterviewProvider,
  };
});

const platformRateLimitMock = vi.hoisted(() => ({ hostedAiRateLimitResponse: vi.fn() }));
vi.mock('@/lib/platformAiRateLimit', () => platformRateLimitMock);

const receiptMock = vi.hoisted(() => ({
  aggregateProvenance: vi.fn(() => ({
    aiProvider: 'gemini',
    aiModel: GEMINI_SYNTHESIS_MODEL,
    requestedAiModel: GEMINI_SYNTHESIS_MODEL,
  })),
}));
vi.mock('@/lib/synthesisReceipt', () => receiptMock);

import { POST } from '@/app/api/synthesis/aggregate/route';

const ANSWER_A = 'I keep a short project note so I remember why I saved it.';
const ANSWER_B = 'I never write anything down about a document.';
const DRIFTED_QUOTE = 'This phrase never appears in any transcript.';

const transcriptA = [
  { id: 'm-1', role: 'ai' as const, content: 'How do you keep track of your work?', timestamp: 1 },
  { id: 'm-2', role: 'user' as const, content: ANSWER_A, timestamp: 2 },
];
const transcriptB = [
  { id: 'm-1', role: 'ai' as const, content: 'How do you keep track of your work?', timestamp: 1 },
  { id: 'm-2', role: 'user' as const, content: ANSWER_B, timestamp: 2 },
];

const synthesisA = {
  statedPreferences: [], revealedPreferences: [],
  themes: [{
    theme: 'Context', frequency: 1,
    evidenceRefs: [
      { quote: 'short project note', turnIndex: 2 },
      { quote: DRIFTED_QUOTE, turnIndex: 2 },
    ],
  }],
  contradictions: [], keyInsights: [], bottomLine: 'A keeps a note.',
};
// Legacy-shaped: must pass through withRecordBackedEvidence unchanged, by identity.
const synthesisB = {
  statedPreferences: [], revealedPreferences: [],
  themes: [{ theme: 'Context', evidence: 'Legacy synthesis for B.', frequency: 1 }],
  contradictions: [], keyInsights: [], bottomLine: 'B keeps nothing.',
};

function makeRequest(studyId: string) {
  return new Request('http://localhost/api/synthesis/aggregate', {
    method: 'POST',
    body: JSON.stringify({ studyId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: {
      kvClient: {},
      geminiApiKey: 'test-key',
      anthropicApiKey: null,
      openaiApiKey: null,
      openrouterApiKey: null,
    },
    researcherId: 'researcher-a',
  });
  contextMock.getAuthorizedResearcherStudyContext.mockImplementation(
    () => contextMock.getRequestContext(),
  );
  platformRateLimitMock.hostedAiRateLimitResponse.mockResolvedValue(null);
  kvMock.saveStudyAggregate.mockResolvedValue('saved');
  kvMock.getStudyChecked.mockImplementation(async (id: string) => {
    const study = await kvMock.getStudy(id);
    return study ? { status: 'found', study } : { status: 'not-found' };
  });
  getInterviewProvider.mockReturnValue({ synthesizeAggregate });
});

describe('POST /api/synthesis/aggregate — resolution and telemetry (Slice L)', () => {
  it('resolves claims to server-stamped ids, drops out-of-range positions, and signs the resolved object', async () => {
    const study = makeStoredStudy({ id: 'study-citations', revision: 1 });
    study.config.id = study.id;
    kvMock.getStudy.mockResolvedValue(study);
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: [
      makeStoredInterview({ id: 'interview-a', studyId: study.id, studyRevision: 1, transcript: transcriptA, synthesis: synthesisA as never }),
      makeStoredInterview({ id: 'interview-b', studyId: study.id, studyRevision: 1, transcript: transcriptB, synthesis: synthesisB as never }),
    ] });

    synthesizeAggregate.mockResolvedValue({
      value: {
        commonThemes: [{
          theme: 'Context', frequency: 2,
          quoteRefs: [
            { interviewIndex: 1, turnIndex: 2, quote: 'short project note' },
            { interviewIndex: 0, turnIndex: 2, quote: 'out of range low' },
            { interviewIndex: 3, turnIndex: 2, quote: 'one past the eligible count' },
            { interviewIndex: 1_000, turnIndex: 2, quote: 'wildly out of range' },
          ],
        }],
        divergentViews: [], keyFindings: [], researchImplications: [],
        bottomLine: 'Both participants track context differently.',
      },
      execution: { provider: 'gemini', requestedModel: GEMINI_SYNTHESIS_MODEL, model: `${GEMINI_SYNTHESIS_MODEL}-served` },
    });

    const response = await POST(makeRequest(study.id));
    expect(response.status).toBe(200);

    const body = await response.json();
    const quoteRefs = body.synthesis.commonThemes[0].quoteRefs;
    expect(quoteRefs).toHaveLength(1);
    expect(quoteRefs[0]).toEqual({ quote: 'short project note', turnIndex: 2, interviewId: 'interview-a' });
    expect(quoteRefs[0].interviewIndex).toBeUndefined();
    expect(body.synthesis.commonThemes[0].representativeQuotes).toBeUndefined();

    // The route no longer signs a receipt (Slice N): the resolved record is
    // persisted directly. This is the same assertion the receipt call used
    // to pin, retargeted at the write that replaced it.
    expect(kvMock.saveStudyAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        commonThemes: [expect.objectContaining({
          quoteRefs: [expect.objectContaining({ interviewId: 'interview-a' })],
        })],
      }),
      expect.anything(),
    );

    // The provider saw a record-backed catalogue: A's drifted ref dropped and
    // its surviving quote rewritten to the record's own characters; B's
    // legacy theme passed through unchanged, by identity.
    const expectedSyntheses = [
      withRecordBackedEvidence(synthesisA as never, transcriptA),
      withRecordBackedEvidence(synthesisB as never, transcriptB),
    ];
    expect(synthesizeAggregate).toHaveBeenCalledWith(study.config, expectedSyntheses, 2);
  });

  it('resolves interviewIndex against ELIGIBLE interviews only, not the raw loaded order', async () => {
    const study = makeStoredStudy({ id: 'study-ordering', revision: 5 });
    study.config.id = study.id;
    kvMock.getStudy.mockResolvedValue(study);
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: [
      makeStoredInterview({ id: 'not-eligible-old', studyId: study.id, studyRevision: 4, transcript: transcriptA, synthesis: synthesisA as never }),
      makeStoredInterview({ id: 'interview-a', studyId: study.id, studyRevision: 5, transcript: transcriptA, synthesis: synthesisA as never }),
      makeStoredInterview({ id: 'not-eligible-no-synthesis', studyId: study.id, studyRevision: 5, synthesis: null }),
      makeStoredInterview({ id: 'interview-b', studyId: study.id, studyRevision: 5, transcript: transcriptB, synthesis: synthesisB as never }),
    ] });

    synthesizeAggregate.mockResolvedValue({
      value: {
        commonThemes: [{
          theme: 'Context', frequency: 1,
          quoteRefs: [{ interviewIndex: 2, turnIndex: 2, quote: ANSWER_B }],
        }],
        divergentViews: [], keyFindings: [], researchImplications: [],
        bottomLine: 'Both participants track context differently.',
      },
      execution: { provider: 'gemini', requestedModel: GEMINI_SYNTHESIS_MODEL, model: `${GEMINI_SYNTHESIS_MODEL}-served` },
    });

    const response = await POST(makeRequest(study.id));
    expect(response.status).toBe(200);
    const body = await response.json();

    // interviewIndex 2 is the SECOND ELIGIBLE interview (interview-b), not
    // the second item in the raw four-item loaded array.
    expect(body.synthesis.commonThemes[0].quoteRefs[0].interviewId).toBe('interview-b');
  });

  it('emits counts-only telemetry: offered includes the dropped claim, located counts only the verified one', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const study = makeStoredStudy({ id: 'study-telemetry', revision: 1 });
    study.config.id = study.id;
    kvMock.getStudy.mockResolvedValue(study);
    kvMock.getStudyInterviewsChecked.mockResolvedValue({ status: 'ok', items: [
      makeStoredInterview({ id: 'interview-a', studyId: study.id, studyRevision: 1, transcript: transcriptA, synthesis: synthesisA as never }),
      makeStoredInterview({ id: 'interview-b', studyId: study.id, studyRevision: 1, transcript: transcriptB, synthesis: synthesisB as never }),
    ] });

    synthesizeAggregate.mockResolvedValue({
      value: {
        commonThemes: [{
          theme: 'Context', frequency: 2,
          quoteRefs: [
            { interviewIndex: 1, turnIndex: 2, quote: 'short project note' }, // verifies
            { interviewIndex: 1_000, turnIndex: 2, quote: 'wildly out of range' }, // dropped, unlocatable
          ],
        }],
        divergentViews: [], keyFindings: [], researchImplications: [],
        bottomLine: 'Both participants track context differently.',
      },
      execution: { provider: 'gemini', requestedModel: GEMINI_SYNTHESIS_MODEL, model: `${GEMINI_SYNTHESIS_MODEL}-served` },
    });

    const response = await POST(makeRequest(study.id));
    expect(response.status).toBe(200);

    const evidenceLines = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('synthesis.evidence'));
    expect(evidenceLines).toHaveLength(1);
    const event = JSON.parse(evidenceLines[0]);
    expect(event.route).toBe('/api/synthesis/aggregate');
    expect(event.refsOffered).toBe(2);
    expect(event.refsLocated).toBe(1);

    const allLogged = JSON.stringify(spy.mock.calls);
    expect(allLogged).not.toContain('short project note');
    expect(allLogged).not.toContain('wildly out of range');
    expect(allLogged).not.toContain(ANSWER_A);
    expect(allLogged).not.toContain(ANSWER_B);
  });
});
