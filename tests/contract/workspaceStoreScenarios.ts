// Backend-neutral WorkspaceStorePort contract scenarios (ST-01, ST-02, ST-03,
// ST-06, ST-07, RT-07). One definition runs against the Redis store (node,
// disposable redis-server) and the Durable Object store (workerd).
//
// Portability rules: imports only `vitest` and type-only `src` modules; no
// Node built-ins; identifiers come from the global `crypto.randomUUID()`.
// Every scenario creates its own studies, sessions, links and budget keys, so
// scenarios may share one underlying store.
//
// Backend differences are expressed through `harness.capabilities`. Recorded
// Redis residuals (refused-delete guard, lifetime-bounded create-idempotency
// index, save-admission overshoot under concurrency, sample clear leaving
// links) are never asserted here, in either direction.
//
// Completion precedence encoded below (the existing P1 order, which the
// durable store reproduces): study missing, then links disabled, then study
// revision, and all of them before duplicate detection.
//
// ST-02 here covers transcripts, charges and counts under concurrent
// completions; its initial-job clause is durable-only and tested there.

import { describe, expect, it } from 'vitest';
import type {
  StoredAggregateSynthesis,
  StoredInterview,
  StoredStudy,
  StudyConfig,
  SynthesisResult,
} from '@/types';
import type { ParticipantConsentRecord } from '@/lib/participantConsent';
import type { ParticipantLinkRecord } from '@/lib/participantLinks';
import type { ParticipantRateLimitCounter, PersistRatePlanRow } from '@/lib/rateLimit';
import type {
  PersistCompletedInterviewInput,
  ResearcherAiCounter,
  WorkspaceStorePort,
} from '@/lib/storage/types';

export type WorkspaceStoreContractCapabilities = {
  /** Link creation and completion re-check study, link and consent at the store. */
  storeBoundaryLinkChecks: boolean;
  /** Save admission checks and charges every row in one transaction. */
  atomicSaveAdmission: boolean;
  /** Sample clear also removes links minted for the sample study. */
  sampleClearCascadesLinks: boolean;
};

export type WorkspaceStoreContractHarness = {
  backend: 'redis' | 'durable-object';
  createStore(): Promise<WorkspaceStorePort>;
  capabilities: WorkspaceStoreContractCapabilities;
};

const MODEL = 'gemini-3.7-flash';
const DAY_SECONDS = 86_400;

type StatusOf<T> = T extends { status: infer S } ? S : never;

function expectStatus<T extends { status: string }, S extends StatusOf<T>>(
  outcome: T,
  status: S,
): Extract<T, { status: S }> {
  expect(outcome.status).toBe(status);
  return outcome as Extract<T, { status: S }>;
}

function uid(): string {
  return crypto.randomUUID();
}

function hex64(): string {
  return `${uid()}${uid()}`.replace(/-/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function studyConfig(id: string, createdAt: number, overrides: Partial<StudyConfig> = {}): StudyConfig {
  return {
    id,
    name: 'Contract study',
    description: 'Synthetic contract fixture.',
    researchQuestion: 'Does every store keep the same contract?',
    coreQuestions: ['What happened first?'],
    topicAreas: ['Contract'],
    profileSchema: [{ id: 'role', label: 'Role', extractionHint: 'Their role', required: false }],
    aiBehavior: 'standard',
    aiProvider: 'gemini',
    aiModel: MODEL,
    consentText: `Synthetic consent for ${id}.`,
    linkExpiration: 'never',
    createdAt,
    ...overrides,
  };
}

function candidateStudy(createdAt = Date.now()): StoredStudy {
  const id = uid();
  return {
    id,
    config: studyConfig(id, createdAt),
    createdAt,
    updatedAt: createdAt,
    interviewCount: 0,
    isLocked: false,
    revision: 1,
  };
}

async function createStudy(store: WorkspaceStorePort, createdAt = Date.now()): Promise<StoredStudy> {
  const outcome = await store.createStudy({
    idempotencyKeyDigest: hex64(),
    fingerprint: hex64(),
    candidate: candidateStudy(createdAt),
  });
  return expectStatus(outcome, 'created').study;
}

async function createLink(
  store: WorkspaceStorePort,
  study: StoredStudy,
  expiresAt: number | null = null,
): Promise<{ code: string; link: ParticipantLinkRecord }> {
  const created = expectStatus(
    await store.createParticipantLink({
      studyId: study.id,
      studyRevision: study.revision,
      expiresAt,
      now: Date.now(),
    }),
    'created',
  );
  return { code: created.code, link: created.link };
}

type Participant = {
  sessionId: string;
  consent: ParticipantConsentRecord;
};

async function consentedParticipant(store: WorkspaceStorePort, study: StoredStudy): Promise<Participant> {
  const sessionId = uid();
  const recorded = expectStatus(
    await store.recordConsent({
      participantSessionId: sessionId,
      studyId: study.id,
      studyRevision: study.revision,
      consentText: study.config.consentText,
      now: Date.now(),
    }),
    'accepted',
  );
  return { sessionId, consent: recorded.consent };
}

function saveRow(maximum: number, now = Date.now()): PersistRatePlanRow {
  const windowStart = Math.floor(now / 1000 / DAY_SECONDS) * DAY_SECONDS;
  return {
    key: `interview-rate:${hex64()}:${windowStart}`,
    maximum,
    windowSeconds: DAY_SECONDS,
    windowStart,
  };
}

function interviewFor(
  study: StoredStudy,
  participant: Participant,
  linkId: string,
  createdAt = Date.now(),
): StoredInterview {
  const id = `session-${participant.sessionId}`;
  return {
    id,
    studyId: study.id,
    studyName: study.config.name,
    participantProfile: { id, fields: [], rawContext: '', timestamp: createdAt },
    transcript: [
      { id: 'm-1', role: 'ai', content: 'Welcome to the study.', timestamp: createdAt },
      { id: 'm-2', role: 'user', content: 'Grüße — naïve café ✓', timestamp: createdAt + 1 },
    ],
    synthesis: null,
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    createdAt,
    completedAt: createdAt + 2,
    status: 'completed',
    studyRevision: study.revision,
    consentHash: participant.consent.consentHash,
    consentAcceptedAt: participant.consent.acceptedAt,
    conductedByProvider: 'gemini',
    conductedByModel: MODEL,
    analysis: { status: 'pending', attempts: 0, lastAttemptAt: createdAt },
    participantLinkId: linkId,
  };
}

function completion(
  study: StoredStudy,
  participant: Participant,
  linkId: string,
  options: {
    expectedStudyRevision?: number;
    ratePlan?: PersistRatePlanRow[];
    fingerprint?: string;
    createdAt?: number;
  } = {},
): PersistCompletedInterviewInput {
  const expectedStudyRevision = options.expectedStudyRevision ?? study.revision;
  return {
    interview: interviewFor(study, participant, linkId, options.createdAt),
    fingerprint: options.fingerprint ?? hex64(),
    expectedStudyRevision,
    allowDisabledLinks: false,
    ratePlan: options.ratePlan ?? [saveRow(10)],
    identity: { participantSessionId: participant.sessionId, linkId },
    consent: {
      participantSessionId: participant.sessionId,
      studyId: study.id,
      studyRevision: expectedStudyRevision,
      consentText: study.config.consentText,
    },
    initialAnalysis: {
      inputSchemaVersion: 1,
      studyConfig: study.config,
      studyRevision: expectedStudyRevision,
      requestedProvider: 'gemini',
      requestedModel: MODEL,
    },
    now: Date.now(),
  };
}

async function persistOne(
  store: WorkspaceStorePort,
  study: StoredStudy,
  linkId: string,
  createdAt = Date.now(),
): Promise<StoredInterview> {
  const participant = await consentedParticipant(store, study);
  const input = completion(study, participant, linkId, { createdAt });
  expect((await store.persistCompletedInterview(input)).status).toBe('created');
  return input.interview;
}

function synthesis(): SynthesisResult {
  return {
    statedPreferences: [],
    revealedPreferences: ['Prefers written notes'],
    themes: [{ theme: 'Routine', frequency: 1, evidenceRefs: [] }],
    contradictions: [],
    keyInsights: ['Synthetic insight'],
    bottomLine: 'Synthetic bottom line.',
  };
}

function aggregateFor(
  study: StoredStudy,
  interviewIds: string[],
  bottomLine: string,
  now = Date.now(),
): StoredAggregateSynthesis {
  return {
    studyId: study.id,
    studyRevision: study.revision,
    interviewIds,
    interviewCount: interviewIds.length,
    aiProvider: 'gemini',
    aiModel: MODEL,
    commonThemes: [{ theme: 'Routine', frequency: interviewIds.length, quoteRefs: [] }],
    divergentViews: [],
    keyFindings: ['Synthetic finding'],
    researchImplications: ['Synthetic implication'],
    bottomLine,
    generatedAt: now,
    savedAt: now,
  };
}

function interviewCounter(maximum: number): ParticipantRateLimitCounter {
  return { key: `rate-limit:interview:session:3600:${uid()}`, maximum, windowSeconds: 3_600 };
}

export function defineWorkspaceStoreContract(label: string, harness: WorkspaceStoreContractHarness): void {
  const { capabilities } = harness;

  describe(`WorkspaceStorePort contract: ${label}`, () => {
    it('ST-01: readiness reports an open, ready store', async () => {
      const store = await harness.createStore();
      expect(store.backend).toBe(harness.backend);
      expect(await store.readiness()).toEqual({ status: 'ready', maintenance: 'open' });
    });

    describe('studies', () => {
      it('ST-01: create returns the minted study; the same key and fingerprint replay it without minting again', async () => {
        const store = await harness.createStore();
        const digest = hex64();
        const fingerprint = hex64();
        const first = candidateStudy();

        const created = expectStatus(
          await store.createStudy({ idempotencyKeyDigest: digest, fingerprint, candidate: first }),
          'created',
        );
        expect(created.replayed).toBe(false);
        expect(created.study).toMatchObject({
          id: first.id,
          revision: 1,
          interviewCount: 0,
          isLocked: false,
          createdAt: first.createdAt,
        });
        expect(created.study.config.id).toBe(first.id);

        const second = candidateStudy();
        const replayed = expectStatus(
          await store.createStudy({ idempotencyKeyDigest: digest, fingerprint, candidate: second }),
          'created',
        );
        expect(replayed.replayed).toBe(true);
        expect(replayed.study.id).toBe(first.id);
        expect(replayed.study.createdAt).toBe(first.createdAt);

        expect(expectStatus(await store.getStudy(first.id), 'found').study.id).toBe(first.id);
        expect((await store.getStudy(second.id)).status).toBe('not-found');
      });

      it('ST-01: reusing a key with a different fingerprint conflicts and creates nothing', async () => {
        const store = await harness.createStore();
        const digest = hex64();
        await store.createStudy({ idempotencyKeyDigest: digest, fingerprint: hex64(), candidate: candidateStudy() });

        const other = candidateStudy();
        const reused = await store.createStudy({ idempotencyKeyDigest: digest, fingerprint: hex64(), candidate: other });
        expect(reused).toEqual({ status: 'key-reuse' });
        expect((await store.getStudy(other.id)).status).toBe('not-found');
      });

      it('ST-01: study reads distinguish a confirmed miss from a found study', async () => {
        const store = await harness.createStore();
        expect(await store.getStudy(uid())).toEqual({ status: 'not-found' });
        const study = await createStudy(store);
        expect(await store.getStudy(study.id)).toEqual({ status: 'found', study });
      });

      it('ST-01: the study list is newest first and reports an explicit too-large outcome', async () => {
        const store = await harness.createStore();
        const base = Date.now();
        const oldest = await createStudy(store, base - 2_000);
        const newest = await createStudy(store, base);
        const middle = await createStudy(store, base - 1_000);

        for (const view of ['full', 'summary'] as const) {
          const listed = expectStatus(await store.listStudies(1_000, { view }), 'ok');
          const ours = listed.items.filter(study => [oldest.id, middle.id, newest.id].includes(study.id));
          expect(ours.map(study => study.id)).toEqual([newest.id, middle.id, oldest.id]);

          const bounded = expectStatus(await store.listStudies(1, { view }), 'too-large');
          expect(bounded.maximum).toBe(1);
          expect(bounded.count).toBeGreaterThanOrEqual(3);
        }
      });

      it('ST-08: the full view lists whole studies; the summary view lists items without the configuration', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);

        const full = expectStatus(await store.listStudies(1_000, { view: 'full' }), 'ok');
        expect(full.items.find(item => item.id === study.id)).toEqual(study);

        const summary = expectStatus(await store.listStudies(1_000, { view: 'summary' }), 'ok');
        const { config, ...metadata } = study;
        expect(summary.items.find(item => item.id === study.id)).toEqual({
          ...metadata,
          config: { name: config.name, description: config.description },
          coreQuestionCount: config.coreQuestions.length,
        });
      });

      it('ST-01: replacing the config advances the revision and a stale expected revision conflicts', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);

        const updated = expectStatus(
          await store.replaceStudyConfig({
            studyId: study.id,
            expectedRevision: 1,
            config: { ...study.config, name: 'Renamed study' },
            now: Date.now(),
          }),
          'updated',
        );
        expect(updated.study).toMatchObject({
          id: study.id,
          revision: 2,
          interviewCount: 0,
          isLocked: false,
          createdAt: study.createdAt,
        });
        expect(updated.study.config.name).toBe('Renamed study');

        const stale = await store.replaceStudyConfig({
          studyId: study.id,
          expectedRevision: 1,
          config: { ...study.config, name: 'Lost update' },
          now: Date.now(),
        });
        expect(stale.status).toBe('conflict');

        const current = expectStatus(await store.getStudy(study.id), 'found').study;
        expect(current.revision).toBe(2);
        expect(current.config.name).toBe('Renamed study');

        const missingId = uid();
        const missing = await store.replaceStudyConfig({
          studyId: missingId,
          expectedRevision: 1,
          config: { ...study.config, id: missingId },
          now: Date.now(),
        });
        expect(missing.status).toBe('not-found');
      });

      it('ST-01: a config whose identity differs from the target study is refused and changes nothing', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);

        const foreign = await store.replaceStudyConfig({
          studyId: study.id,
          expectedRevision: 1,
          config: { ...study.config, id: uid(), name: 'Foreign identity' },
          now: Date.now(),
        });
        expect(foreign.status).not.toBe('updated');

        const current = expectStatus(await store.getStudy(study.id), 'found').study;
        expect(current.revision).toBe(1);
        expect(current.config).toEqual(study.config);
      });

      it('ST-01: toggling participant links advances the revision each time', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);

        const disabled = expectStatus(
          await store.setStudyLinksEnabled({ studyId: study.id, enabled: false, now: Date.now() }),
          'updated',
        );
        expect(disabled.study.revision).toBe(2);
        expect(disabled.study.config.linksEnabled).toBe(false);

        const enabled = expectStatus(
          await store.setStudyLinksEnabled({ studyId: study.id, enabled: true, now: Date.now() }),
          'updated',
        );
        expect(enabled.study.revision).toBe(3);
        expect(enabled.study.config.linksEnabled).toBe(true);
      });

      it('ST-01: deleting an empty study removes it, and deleting again stays deleted', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);

        const deleted = await store.deleteStudy({ studyId: study.id, now: Date.now() });
        expect(deleted).toMatchObject({ status: 'deleted', success: true });
        expect(await store.getStudy(study.id)).toEqual({ status: 'not-found' });
        const listed = expectStatus(await store.listStudies(1_000, { view: 'summary' }), 'ok');
        expect(listed.items.some(item => item.id === study.id)).toBe(false);

        const again = await store.deleteStudy({ studyId: study.id, now: Date.now() });
        expect(again).toMatchObject({ status: 'deleted', success: true });
      });

      it('ST-01: deleting a study that holds interviews is refused', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const { link } = await createLink(store, study);
        await persistOne(store, study, link.id);

        const refused = await store.deleteStudy({ studyId: study.id, now: Date.now() });
        expect(refused).toMatchObject({ status: 'conflict', success: false });
      });
    });

    describe('participant links', () => {
      it('ST-01: a created link resolves by its one-time code and by id, and lists only metadata', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const { code, link } = await createLink(store, study);

        expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(link).toMatchObject({
          studyId: study.id,
          studyRevision: 1,
          expiresAt: null,
          revokedAt: null,
        });
        expect(link.id).toMatch(/^[a-f0-9]{64}$/);

        const byCode = expectStatus(
          await store.resolveParticipantLinkByCode({ code, now: Date.now(), purpose: 'exchange' }),
          'found',
        );
        expect(byCode.link.id).toBe(link.id);
        const byId = expectStatus(await store.getParticipantLinkById({ linkId: link.id, now: Date.now() }), 'found');
        expect(byId.link.studyId).toBe(study.id);

        const unknownCode = 'A'.repeat(43);
        expect(await store.resolveParticipantLinkByCode({ code: unknownCode, now: Date.now(), purpose: 'exchange' }))
          .toEqual({ status: 'not-found' });
        expect(await store.resolveParticipantLinkByCode({ code: 'not-a-code', now: Date.now(), purpose: 'exchange' }))
          .toEqual({ status: 'not-found' });
        expect(await store.getParticipantLinkById({ linkId: hex64(), now: Date.now() }))
          .toEqual({ status: 'not-found' });

        const listed = expectStatus(
          await store.listParticipantLinks({ studyId: study.id, maximum: 100, now: Date.now() }),
          'ok',
        );
        expect(listed.truncated).toBe(false);
        expect(listed.links).toEqual([{
          id: link.id,
          studyRevision: 1,
          createdAt: link.createdAt,
          expiresAt: null,
          revokedAt: null,
        }]);
      });

      it('ST-03: revocation refuses the link afterwards, is idempotent and owner-checked', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const other = await createStudy(store);
        const { code, link } = await createLink(store, study);

        expect(await store.revokeParticipantLink({ studyId: other.id, linkId: link.id, now: Date.now() }))
          .toEqual({ status: 'owner-conflict' });

        const revoked = expectStatus(
          await store.revokeParticipantLink({ studyId: study.id, linkId: link.id, now: Date.now() }),
          'revoked',
        );
        expect(Number.isSafeInteger(revoked.revokedAt)).toBe(true);
        expect(await store.revokeParticipantLink({ studyId: study.id, linkId: link.id, now: Date.now() }))
          .toEqual({ status: 'already-revoked' });

        expect(await store.resolveParticipantLinkByCode({ code, now: Date.now(), purpose: 'exchange' }))
          .toEqual({ status: 'revoked' });
        expect(await store.getParticipantLinkById({ linkId: link.id, now: Date.now() }))
          .toEqual({ status: 'revoked' });

        const listed = expectStatus(
          await store.listParticipantLinks({ studyId: study.id, maximum: 100, now: Date.now() }),
          'ok',
        );
        expect(listed.links).toHaveLength(1);
        expect(listed.links[0].revokedAt).not.toBeNull();

        expect(await store.revokeParticipantLink({ studyId: study.id, linkId: hex64(), now: Date.now() }))
          .toEqual({ status: 'not-found' });
      });

      it('ST-03: an expired link is refused and no longer listed', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const { code, link } = await createLink(store, study, Date.now() + 300);
        await sleep(450);

        const now = Date.now();
        const resolved = await store.resolveParticipantLinkByCode({ code, now, purpose: 'exchange' });
        expect(['expired', 'not-found']).toContain(resolved.status);
        const byId = await store.getParticipantLinkById({ linkId: link.id, now });
        expect(['expired', 'not-found']).toContain(byId.status);

        const listed = expectStatus(await store.listParticipantLinks({ studyId: study.id, maximum: 100, now }), 'ok');
        expect(listed.links.some(entry => entry.id === link.id)).toBe(false);
      });

      it.skipIf(!capabilities.storeBoundaryLinkChecks)(
        'ST-03: link creation re-checks the study, its revision and link state at the store',
        async () => {
          const store = await harness.createStore();
          const missing = await store.createParticipantLink({
            studyId: uid(),
            studyRevision: 1,
            expiresAt: null,
            now: Date.now(),
          });
          expect(missing.status).toBe('study-not-found');

          const study = await createStudy(store);
          await store.replaceStudyConfig({
            studyId: study.id,
            expectedRevision: 1,
            config: { ...study.config, name: 'Edited' },
            now: Date.now(),
          });
          const stale = await store.createParticipantLink({
            studyId: study.id,
            studyRevision: 1,
            expiresAt: null,
            now: Date.now(),
          });
          expect(stale.status).toBe('revision-stale');

          await store.setStudyLinksEnabled({ studyId: study.id, enabled: false, now: Date.now() });
          const disabled = await store.createParticipantLink({
            studyId: study.id,
            studyRevision: 3,
            expiresAt: null,
            now: Date.now(),
          });
          expect(disabled.status).toBe('links-disabled');
        },
      );
    });

    describe('consent', () => {
      it('ST-03: consent records once, a replay keeps the original acceptance time, and verify binds session, revision and text', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const sessionId = uid();
        const binding = {
          participantSessionId: sessionId,
          studyId: study.id,
          studyRevision: 1,
          consentText: study.config.consentText,
        };

        const first = expectStatus(await store.recordConsent({ ...binding, now: Date.now() }), 'accepted');
        expect(first.consent).toMatchObject({ participantSessionId: sessionId, studyId: study.id, studyRevision: 1 });
        expect(first.consent.consentHash).toMatch(/^[a-f0-9]{64}$/);
        expect(first.consent.acceptedAt).toBeGreaterThan(0);

        await sleep(5);
        const replay = expectStatus(await store.recordConsent({ ...binding, now: Date.now() + 1_000 }), 'accepted');
        expect(replay.consent.acceptedAt).toBe(first.consent.acceptedAt);

        const verified = expectStatus(await store.verifyConsent({ ...binding, now: Date.now() }), 'accepted');
        expect(verified.consent.acceptedAt).toBe(first.consent.acceptedAt);

        expect((await store.verifyConsent({ ...binding, studyRevision: 2, now: Date.now() })).status).toBe('mismatch');
        expect((await store.verifyConsent({ ...binding, consentText: 'Different text.', now: Date.now() })).status)
          .toBe('mismatch');
        expect((await store.verifyConsent({ ...binding, participantSessionId: uid(), now: Date.now() })).status)
          .toBe('missing');

        expect((await store.recordConsent({ ...binding, studyRevision: 2, now: Date.now() })).status).toBe('conflict');
      });
    });

    describe('participant admission', () => {
      it('ST-06: admission admits up to the maximum, then refuses without charging any other scope', async () => {
        const store = await harness.createStore();
        const limited = interviewCounter(2);
        const shared = interviewCounter(3);
        const admit = (counters: ParticipantRateLimitCounter[]) =>
          store.admitParticipantRequest({ operation: 'interview', counters, now: Date.now() });

        expect(await admit([limited, shared])).toEqual({ status: 'admitted' });
        expect(await admit([limited, shared])).toEqual({ status: 'admitted' });

        const refused = expectStatus(await admit([limited, shared]), 'limited');
        expect(refused.rejectedIndex).toBe(0);
        expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(refused.retryAfterSeconds).toBeLessThanOrEqual(3_600);

        // The refusal charged nothing: `shared` still has exactly one unit left.
        expect(await admit([interviewCounter(5), shared])).toEqual({ status: 'admitted' });
        const exhausted = expectStatus(await admit([interviewCounter(5), shared]), 'limited');
        expect(exhausted.rejectedIndex).toBe(1);
      });

      it('ST-06: concurrent admissions never exceed the maximum', async () => {
        const store = await harness.createStore();
        const counter = interviewCounter(3);
        const outcomes = await Promise.all(Array.from({ length: 8 }, () =>
          store.admitParticipantRequest({ operation: 'interview', counters: [counter], now: Date.now() })));
        expect(outcomes.filter(outcome => outcome.status === 'admitted')).toHaveLength(3);
        expect(outcomes.filter(outcome => outcome.status === 'limited')).toHaveLength(5);
      });

      it('RT-07: every request mapped to one shared client bucket draws on the same budget', async () => {
        const store = await harness.createStore();
        const sharedClient: ParticipantRateLimitCounter = {
          key: `rate-limit:greeting:client:60:${uid()}:unknown-bucket`,
          maximum: 2,
          windowSeconds: 60,
        };
        const admitSession = () => store.admitParticipantRequest({
          operation: 'greeting',
          counters: [interviewCounter(3), sharedClient],
          now: Date.now(),
        });

        expect((await admitSession()).status).toBe('admitted');
        expect((await admitSession()).status).toBe('admitted');
        const third = expectStatus(await admitSession(), 'limited');
        expect(third.rejectedIndex).toBe(1);
      });
    });

    describe('researcher AI admission (D15)', () => {
      const researcherCounter = (maximum: number): ResearcherAiCounter =>
        ({ key: `researcher-ai:aggregate:session:3600:${uid()}`, maximum, windowSeconds: 3_600 });

      it('D15: admits up to the maximum, then refuses without charging any other scope', async () => {
        const store = await harness.createStore();
        const limited = researcherCounter(1);
        const shared = researcherCounter(2);
        const admit = (counters: ResearcherAiCounter[]) =>
          store.admitResearcherAiRequest({ operation: 'aggregate', counters, now: Date.now() });

        expect(await admit([limited, shared])).toEqual({ status: 'admitted' });
        const refused = expectStatus(await admit([limited, shared]), 'limited');
        expect(refused.rejectedIndex).toBe(0);
        expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(refused.retryAfterSeconds).toBeLessThanOrEqual(3_600);

        expect(await admit([researcherCounter(5), shared])).toEqual({ status: 'admitted' });
        expect(expectStatus(await admit([researcherCounter(5), shared]), 'limited').rejectedIndex).toBe(1);
      });

      it('D15: concurrent admissions never exceed the maximum', async () => {
        const store = await harness.createStore();
        const counter = researcherCounter(3);
        const outcomes = await Promise.all(Array.from({ length: 8 }, () =>
          store.admitResearcherAiRequest({ operation: 'aggregate', counters: [counter], now: Date.now() })));
        expect(outcomes.filter(outcome => outcome.status === 'admitted')).toHaveLength(3);
        expect(outcomes.filter(outcome => outcome.status === 'limited')).toHaveLength(5);
      });

      it('D15: a participant key is never charged as a researcher budget, and the two budgets are separate', async () => {
        const store = await harness.createStore();
        const subject = uid();
        const participant = { key: `rate-limit:greeting:session:600:${subject}`, maximum: 1, windowSeconds: 600 };
        const researcher = { key: `researcher-ai:greeting:session:600:${subject}`, maximum: 1, windowSeconds: 600 };

        expect(await store.admitResearcherAiRequest({ operation: 'greeting', counters: [participant], now: Date.now() }))
          .toEqual({ status: 'unavailable' });
        expect(await store.admitParticipantRequest({ operation: 'greeting', counters: [participant], now: Date.now() }))
          .toEqual({ status: 'admitted' });
        expect(await store.admitResearcherAiRequest({ operation: 'greeting', counters: [researcher], now: Date.now() }))
          .toEqual({ status: 'admitted' });
      });
    });

    describe('completion', () => {
      it('ST-02: completion creates once, an identical replay is a duplicate, and a different fingerprint conflicts', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const { link } = await createLink(store, study);
        const participant = await consentedParticipant(store, study);
        const input = completion(study, participant, link.id);

        expect(await store.persistCompletedInterview(input)).toEqual({ status: 'created' });

        const stored = expectStatus(await store.getInterview(input.interview.id), 'found').interview;
        expect(stored).toMatchObject({
          id: input.interview.id,
          studyId: study.id,
          status: 'completed',
          studyRevision: 1,
          participantLinkId: link.id,
          consentHash: participant.consent.consentHash,
          conductedByProvider: 'gemini',
          conductedByModel: MODEL,
        });
        expect(stored.transcript).toEqual(input.interview.transcript);
        expect(stored.behaviorData).toEqual(input.interview.behaviorData);

        const locked = expectStatus(await store.getStudy(study.id), 'found').study;
        expect(locked).toMatchObject({ interviewCount: 1, isLocked: true, revision: 1 });

        expect(await store.persistCompletedInterview(input)).toEqual({ status: 'duplicate' });
        expect(await store.persistCompletedInterview({ ...input, now: Date.now() })).toEqual({ status: 'duplicate' });
        expect(expectStatus(await store.getStudy(study.id), 'found').study.interviewCount).toBe(1);

        const changed = {
          ...input,
          fingerprint: hex64(),
          interview: {
            ...input.interview,
            transcript: [...input.interview.transcript, { id: 'm-3', role: 'user' as const, content: 'Changed', timestamp: 3 }],
          },
        };
        expect(await store.persistCompletedInterview(changed)).toEqual({ status: 'conflict' });

        const listed = expectStatus(
          await store.listInterviews({ scope: 'study', studyId: study.id, maximum: 1_000 }),
          'ok',
        );
        expect(listed.items.map(item => item.id)).toEqual([input.interview.id]);
      });

      it('ST-02: concurrent identical completions store one transcript, charge the save budget once and count once', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const { link } = await createLink(store, study);
        const row = saveRow(2);
        const input = completion(study, await consentedParticipant(store, study), link.id, { ratePlan: [row] });

        const outcomes = await Promise.all(Array.from({ length: 4 }, () =>
          store.persistCompletedInterview({ ...input })));
        expect(outcomes.filter(outcome => outcome.status === 'created')).toHaveLength(1);
        expect(outcomes.filter(outcome => outcome.status === 'duplicate')).toHaveLength(3);

        // A lost response replays without duplication.
        expect(await store.persistCompletedInterview(input)).toEqual({ status: 'duplicate' });
        const stored = expectStatus(await store.getInterview(input.interview.id), 'found').interview;
        expect(stored.transcript).toEqual(input.interview.transcript);
        expect(expectStatus(await store.getStudy(study.id), 'found').study.interviewCount).toBe(1);

        // `row` (maximum 2) was charged once: one more distinct completion fits, the next does not.
        const next = completion(study, await consentedParticipant(store, study), link.id, { ratePlan: [row] });
        expect(await store.persistCompletedInterview(next)).toEqual({ status: 'created' });
        const over = completion(study, await consentedParticipant(store, study), link.id, { ratePlan: [row] });
        expect(await store.persistCompletedInterview(over)).toEqual({ status: 'rate-limited' });
        expect(expectStatus(await store.getStudy(study.id), 'found').study.interviewCount).toBe(2);
      });

      it('ST-02: concurrent completions of one session with different content keep exactly one immutable transcript', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const { link } = await createLink(store, study);
        const base = completion(study, await consentedParticipant(store, study), link.id);
        const variants = [0, 1, 2].map(index => ({
          ...base,
          fingerprint: hex64(),
          interview: {
            ...base.interview,
            transcript: [
              ...base.interview.transcript,
              { id: 'm-3', role: 'user' as const, content: `Variant ${index}`, timestamp: base.interview.createdAt + 1 },
            ],
          },
        }));

        const outcomes = await Promise.all(variants.map(variant => store.persistCompletedInterview(variant)));
        const winners = outcomes.flatMap((outcome, index) => outcome.status === 'created' ? [index] : []);
        expect(winners).toHaveLength(1);
        expect(outcomes.filter(outcome => outcome.status === 'conflict')).toHaveLength(2);

        const winner = variants[winners[0]];
        const stored = expectStatus(await store.getInterview(base.interview.id), 'found').interview;
        expect(stored.transcript).toEqual(winner.interview.transcript);
        expect(await store.persistCompletedInterview(winner)).toEqual({ status: 'duplicate' });
        for (const [index, variant] of variants.entries()) {
          if (index !== winners[0]) {
            expect(await store.persistCompletedInterview(variant)).toEqual({ status: 'conflict' });
          }
        }
        expect(expectStatus(await store.getStudy(study.id), 'found').study.interviewCount).toBe(1);
      });

      it('ST-03: completion refuses a stale revision, then disabled links, even for a replay of a committed save', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const { link } = await createLink(store, study);
        const committed = completion(study, await consentedParticipant(store, study), link.id);
        expect(await store.persistCompletedInterview(committed)).toEqual({ status: 'created' });
        const late = completion(study, await consentedParticipant(store, study), link.id);
        const later = completion(study, await consentedParticipant(store, study), link.id);

        await store.replaceStudyConfig({
          studyId: study.id,
          expectedRevision: 1,
          config: { ...study.config, name: 'Edited during collection' },
          now: Date.now(),
        });
        expect(await store.persistCompletedInterview(late)).toEqual({ status: 'revision-stale' });
        expect(await store.persistCompletedInterview(committed)).toEqual({ status: 'revision-stale' });

        await store.setStudyLinksEnabled({ studyId: study.id, enabled: false, now: Date.now() });
        expect(await store.persistCompletedInterview(later)).toEqual({ status: 'links-disabled' });
        expect(await store.persistCompletedInterview(committed)).toEqual({ status: 'links-disabled' });

        expect((await store.getInterview(late.interview.id)).status).toBe('not-found');
        expect((await store.getInterview(later.interview.id)).status).toBe('not-found');
        const current = expectStatus(await store.getStudy(study.id), 'found').study;
        expect(current.interviewCount).toBe(1);
      });

      it('ST-03: completion into a deleted study is refused', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const { link } = await createLink(store, study);
        const input = completion(study, await consentedParticipant(store, study), link.id);

        expect((await store.deleteStudy({ studyId: study.id, now: Date.now() })).status).toBe('deleted');
        expect(await store.persistCompletedInterview(input)).toEqual({ status: 'study-not-found' });
        expect(await store.getInterview(input.interview.id)).toEqual({ status: 'not-found' });
      });

      it('ST-06: save admission refuses past a budget without charging any row, and a duplicate never charges twice', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const { link } = await createLink(store, study);
        const now = Date.now();
        const tight = saveRow(1, now);
        const shared = saveRow(2, now);
        const persist = async (rows: PersistRatePlanRow[]) => {
          const input = completion(study, await consentedParticipant(store, study), link.id, { ratePlan: rows });
          return { input, outcome: await store.persistCompletedInterview(input) };
        };

        const first = await persist([tight, shared]);
        expect(first.outcome).toEqual({ status: 'created' });
        const refused = await persist([tight, shared]);
        expect(refused.outcome).toEqual({ status: 'rate-limited' });

        // `shared` was charged once (by `first`), not by the refusal.
        const second = await persist([saveRow(1, now), shared]);
        expect(second.outcome).toEqual({ status: 'created' });
        const exhausted = await persist([saveRow(1, now), shared]);
        expect(exhausted.outcome).toEqual({ status: 'rate-limited' });

        expect(await store.persistCompletedInterview(first.input)).toEqual({ status: 'duplicate' });
        expect((await store.getInterview(refused.input.interview.id)).status).toBe('not-found');
        const listed = expectStatus(
          await store.listInterviews({ scope: 'study', studyId: study.id, maximum: 1_000 }),
          'ok',
        );
        expect(listed.items.map(item => item.id).sort())
          .toEqual([first.input.interview.id, second.input.interview.id].sort());
      });
    });

    describe('concurrent save admission', () => {
      it.skipIf(!capabilities.atomicSaveAdmission)(
        'ST-06: concurrent completions against one remaining unit admit exactly one',
        async () => {
          const store = await harness.createStore();
          const study = await createStudy(store);
          const { link } = await createLink(store, study);
          const row = saveRow(1);
          const inputs = await Promise.all([0, 1, 2].map(async () =>
            completion(study, await consentedParticipant(store, study), link.id, { ratePlan: [row] })));

          const outcomes = await Promise.all(inputs.map(input => store.persistCompletedInterview(input)));
          expect(outcomes.filter(outcome => outcome.status === 'created')).toHaveLength(1);
          expect(outcomes.filter(outcome => outcome.status === 'rate-limited')).toHaveLength(2);
          expect(expectStatus(await store.getStudy(study.id), 'found').study.interviewCount).toBe(1);
        },
      );
    });

    describe('interview reads', () => {
      it('ST-01: interview reads distinguish a miss; lists are per study or global, newest first and bounded', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const other = await createStudy(store);
        const { link } = await createLink(store, study);
        const { link: otherLink } = await createLink(store, other);
        const base = Date.now();
        const older = await persistOne(store, study, link.id, base - 1_000);
        const newer = await persistOne(store, study, link.id, base);
        const elsewhere = await persistOne(store, other, otherLink.id, base);

        expect(await store.getInterview(`session-${uid()}`)).toEqual({ status: 'not-found' });
        expect(expectStatus(await store.getInterview(newer.id), 'found').interview.id).toBe(newer.id);

        const scoped = expectStatus(
          await store.listInterviews({ scope: 'study', studyId: study.id, maximum: 1_000 }),
          'ok',
        );
        expect(scoped.items.map(item => item.id)).toEqual([newer.id, older.id]);

        const all = expectStatus(await store.listInterviews({ scope: 'all', maximum: 5_000 }), 'ok');
        const ids = all.items.map(item => item.id);
        expect(ids).toEqual(expect.arrayContaining([older.id, newer.id, elsewhere.id]));

        const bounded = expectStatus(
          await store.listInterviews({ scope: 'study', studyId: study.id, maximum: 1 }),
          'too-large',
        );
        expect(bounded).toEqual({ status: 'too-large', count: 2, maximum: 1 });

        expect(expectStatus(
          await store.listInterviews({ scope: 'study', studyId: uid(), maximum: 1_000 }),
          'ok',
        ).items).toEqual([]);
      });
    });

    describe('aggregate', () => {
      it('ST-01: aggregate saves replace the latest value, reads distinguish a miss, and oversize is refused', async () => {
        const store = await harness.createStore();
        const study = await createStudy(store);
        const { link } = await createLink(store, study);
        const interview = await persistOne(store, study, link.id);

        expect(await store.getAggregate(study.id)).toEqual({ status: 'not-found' });

        const first = aggregateFor(study, [interview.id], 'First bottom line.');
        expect(await store.saveAggregate(first)).toBe('saved');
        expect(await store.getAggregate(study.id)).toEqual({ status: 'found', aggregate: first });

        const second = aggregateFor(study, [interview.id], 'Replacement — ünïcode ✓');
        expect(await store.saveAggregate(second)).toBe('saved');
        expect(await store.getAggregate(study.id)).toEqual({ status: 'found', aggregate: second });

        const oversized = aggregateFor(study, [interview.id], 'x'.repeat(260_000));
        expect(await store.saveAggregate(oversized)).toBe('too-large');
        expect(await store.getAggregate(study.id)).toEqual({ status: 'found', aggregate: second });
      });
    });

    describe('sample workspace', () => {
      it('ST-07: sample seed writes the set once, refuses a second seed, and clear removes it with its aggregate', async () => {
        const store = await harness.createStore();
        const now = Date.now();
        const studyId = `demo-contract-${uid()}`;
        const sampleStudy: StoredStudy = {
          id: studyId,
          config: studyConfig(studyId, now - 60_000, { linkExpiration: '30days' }),
          createdAt: now - 60_000,
          updatedAt: now - 60_000,
          interviewCount: 2,
          isLocked: true,
          revision: 1,
        };
        const sampleInterviews: StoredInterview[] = ['alpha', 'beta'].map((name, index) => ({
          id: `interview-${studyId}-${name}`,
          studyId,
          studyName: sampleStudy.config.name,
          participantProfile: { id: `profile-${name}`, fields: [], rawContext: 'Synthetic', timestamp: now - 50_000 },
          transcript: [{ id: 'm-1', role: 'ai', content: 'Synthetic sample turn.', timestamp: now - 50_000 }],
          synthesis: synthesis(),
          behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
          createdAt: now - 50_000 + index,
          completedAt: now - 40_000 + index,
          status: 'completed',
          studyRevision: 1,
        }));
        const seedInput = { studies: [sampleStudy], interviews: sampleInterviews, now };
        const clearInput = { studyIds: [studyId], interviewIds: sampleInterviews.map(item => item.id) };

        expect(await store.seedSampleWorkspace(seedInput))
          .toEqual({ status: 'seeded', studiesSeeded: 1, interviewsSeeded: 2 });
        expect(await store.seedSampleWorkspace({ ...seedInput, now: Date.now() })).toEqual({ status: 'already-seeded' });

        expect(expectStatus(await store.getStudy(studyId), 'found').study.id).toBe(studyId);
        const seeded = expectStatus(await store.listInterviews({ scope: 'study', studyId, maximum: 1_000 }), 'ok');
        expect(seeded.items.map(item => item.id).sort()).toEqual(clearInput.interviewIds.slice().sort());

        expect(await store.saveAggregate(aggregateFor(sampleStudy, clearInput.interviewIds, 'Sample aggregate.')))
          .toBe('saved');
        const sampleLink = capabilities.sampleClearCascadesLinks ? await createLink(store, sampleStudy) : null;

        expect(await store.clearSampleWorkspace(clearInput))
          .toEqual({ status: 'cleared', studiesDeleted: 1, interviewsDeleted: 2 });
        expect(await store.getStudy(studyId)).toEqual({ status: 'not-found' });
        for (const interviewId of clearInput.interviewIds) {
          expect(await store.getInterview(interviewId)).toEqual({ status: 'not-found' });
        }
        expect(await store.getAggregate(studyId)).toEqual({ status: 'not-found' });
        expect(expectStatus(await store.listInterviews({ scope: 'study', studyId, maximum: 1_000 }), 'ok').items)
          .toEqual([]);
        if (sampleLink) {
          const resolved = await store.getParticipantLinkById({ linkId: sampleLink.link.id, now: Date.now() });
          expect(resolved.status).not.toBe('found');
        }

        // A re-seed after clear starts clean: the old aggregate does not return.
        expect(await store.seedSampleWorkspace({ ...seedInput, now: Date.now() }))
          .toEqual({ status: 'seeded', studiesSeeded: 1, interviewsSeeded: 2 });
        expect(await store.getAggregate(studyId)).toEqual({ status: 'not-found' });
        expect((await store.clearSampleWorkspace(clearInput)).status).toBe('cleared');
      });
    });
  });
}
