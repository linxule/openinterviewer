// Synthetic builders for WorkspaceStore domain tests. No participant content,
// credentials or production data: every record here is invented.
import { expect, vi } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type * as Rpc from '../../cloudflare/workspace/rpcTypes';
import type { FrozenAnalysisInput } from '../../src/lib/storage/analysisProtocol';
import type { PersistCompletedInterviewInput } from '../../src/lib/storage/types';
import type { StoredInterview, StoredStudy, StudyConfig } from '../../src/types';
import { testEnv, workspaceStub } from './helpers';

/**
 * Operation clock, far ahead of real time. Jobs allocated by these tests are
 * due at T0, so the object's alarm never fires during a run and the
 * assertions observe exactly what the operation committed.
 */
export const T0 = Date.UTC(2031, 0, 6, 12, 0, 0);
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomHex64(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------- SQL inspection ----------

export async function sql<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Promise<T[]> {
  return runInDurableObject(workspaceStub(), (_instance, state) =>
    state.storage.sql.exec(query, ...bindings).toArray() as unknown as T[],
  );
}

export async function count(table: string, where = '1 = 1', ...bindings: unknown[]): Promise<number> {
  const rows = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...bindings);
  return rows[0].n;
}

export async function alarmAt(): Promise<number | null> {
  return runInDurableObject(workspaceStub(), (_instance, state) => state.storage.getAlarm());
}

export async function mutationSeq(): Promise<number> {
  const rows = await sql<{ mutation_seq: number }>(`SELECT mutation_seq FROM workspace_meta`);
  return rows[0].mutation_seq;
}

export async function setMaintenance(state: 'open' | 'draining' | 'frozen' | 'recovery'): Promise<void> {
  await sql(`UPDATE workspace_meta SET maintenance_state = ?`, state);
}

/**
 * Structured `workspace.store` events the object logs (it shares this
 * isolate). Callers restore the spy with vi.restoreAllMocks().
 */
export function captureStoreEvents(): () => Array<Record<string, unknown>> {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
  return () =>
    lines.flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.event === 'workspace.store' ? [event] : [];
      } catch {
        return [];
      }
    });
}

// ---------- Studies ----------

export function studyConfig(id: string, overrides: Partial<StudyConfig> = {}): StudyConfig {
  return {
    id,
    name: 'Synthetic study',
    description: 'A synthetic study used only by tests.',
    researchQuestion: 'How do synthetic participants describe synthetic work?',
    coreQuestions: ['Describe a synthetic task.'],
    topicAreas: ['Synthetic topic'],
    profileSchema: [],
    aiBehavior: 'standard',
    aiProvider: 'openai',
    aiModel: 'gpt-5.6-terra',
    consentText: 'Synthetic consent text for tests.',
    createdAt: T0 - DAY,
    ...overrides,
  };
}

export function candidateStudy(configOverrides: Partial<StudyConfig> = {}): StoredStudy {
  const id = crypto.randomUUID();
  return {
    id,
    config: studyConfig(id, configOverrides),
    createdAt: T0 - DAY,
    updatedAt: T0 - DAY,
    interviewCount: 0,
    isLocked: false,
    revision: 1,
  };
}

export async function createStudyInput(candidate: StoredStudy = candidateStudy(), key = crypto.randomUUID()) {
  return {
    idempotencyKeyDigest: await sha256Hex(`key:${key}`),
    fingerprint: await sha256Hex(`fp:${JSON.stringify(candidate.config)}`),
    candidate,
  };
}

export async function createStudy(configOverrides: Partial<StudyConfig> = {}): Promise<StoredStudy> {
  const candidate = candidateStudy(configOverrides);
  const outcome = await workspaceStub().createStudy(await createStudyInput(candidate));
  expect(outcome).toMatchObject({ status: 'created', replayed: false });
  return candidate;
}

export async function currentStudy(studyId: string): Promise<StoredStudy> {
  const loaded = await workspaceStub().getStudy({ studyId });
  if (loaded.status !== 'found') throw new Error(`study ${loaded.status}`);
  return loaded.study;
}

// ---------- Participants ----------

export type Participant = {
  study: StoredStudy;
  linkId: string;
  sessionId: string;
  consentHash: string;
  consentAcceptedAt: number;
  /** The transport disclosed at consent (absent = direct). */
  disclosedTransport?: 'cloudflare-gateway';
};

/** Link plus recorded consent for a fresh participant session at `now`. */
export async function enrolParticipant(
  study: StoredStudy,
  options: { now?: number; expiresAt?: number | null; disclosedTransport?: 'cloudflare-gateway' } = {},
): Promise<Participant> {
  const now = options.now ?? T0;
  const stub = workspaceStub();
  const linkId = randomHex64();
  const created = await stub.createParticipantLink({
    linkId,
    studyId: study.id,
    studyRevision: study.revision,
    expiresAt: options.expiresAt === undefined ? now + 30 * DAY : options.expiresAt,
    now,
  });
  expect(created.status).toBe('created');
  const sessionId = crypto.randomUUID();
  const consentHash = await sha256Hex(study.config.consentText);
  const consent = await stub.recordConsent({
    participantSessionId: sessionId,
    studyId: study.id,
    studyRevision: study.revision,
    consentHash,
    now,
    ...(options.disclosedTransport ? { disclosedTransport: options.disclosedTransport } : {}),
  });
  if (consent.status !== 'accepted') throw new Error(`consent ${consent.status}`);
  return {
    study,
    linkId,
    sessionId,
    consentHash,
    consentAcceptedAt: consent.consent.acceptedAt,
    ...(options.disclosedTransport ? { disclosedTransport: options.disclosedTransport } : {}),
  };
}

// ---------- Interviews ----------

export function interviewRecord(participant: Participant, overrides: Partial<StoredInterview> = {}): StoredInterview {
  const id = `session-${participant.sessionId}`;
  return {
    id,
    studyId: participant.study.id,
    studyName: participant.study.config.name,
    participantProfile: { id, fields: [], rawContext: '', timestamp: T0 - HOUR },
    transcript: [
      { id: 'm1', role: 'ai', content: 'Welcome to a synthetic interview.', timestamp: T0 - HOUR },
      { id: 'm2', role: 'user', content: 'A synthetic answer.', timestamp: T0 - HOUR + 1000 },
    ],
    synthesis: null,
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    createdAt: T0 - HOUR,
    completedAt: T0,
    status: 'completed',
    studyRevision: participant.study.revision,
    consentHash: participant.consentHash,
    consentAcceptedAt: participant.consentAcceptedAt,
    conductedByProvider: participant.study.config.aiProvider,
    conductedByModel: participant.study.config.aiModel,
    analysis: { status: 'pending', attempts: 0, lastAttemptAt: T0 },
    participantLinkId: participant.linkId,
    ...(participant.disclosedTransport ? { consentTransport: participant.disclosedTransport } : {}),
    ...overrides,
  };
}

export function frozenInput(study: StoredStudy, disclosedTransport?: 'cloudflare-gateway'): FrozenAnalysisInput {
  return {
    inputSchemaVersion: 1,
    studyConfig: study.config,
    studyRevision: study.revision,
    requestedProvider: study.config.aiProvider ?? 'openai',
    requestedModel: study.config.aiModel ?? 'gpt-5.6-terra',
    ...(disclosedTransport ? { disclosedTransport } : {}),
  };
}

export function windowStart(now: number, windowSeconds: number): number {
  const seconds = Math.floor(now / 1000);
  return Math.floor(seconds / windowSeconds) * windowSeconds;
}

export function planRow(maximum: number, options: { windowSeconds?: number; planId?: string; now?: number } = {}) {
  const windowSeconds = options.windowSeconds ?? 86_400;
  const start = windowStart(options.now ?? T0, windowSeconds);
  return {
    key: `interview-rate:${options.planId ?? randomHex64()}:${start}`,
    maximum,
    windowSeconds,
    windowStart: start,
  };
}

/** The durable completion input the save route would build for this participant. */
export async function persistInput(
  participant: Participant,
  options: {
    interview?: StoredInterview;
    ratePlan?: PersistCompletedInterviewInput['ratePlan'];
    now?: number;
    expectedStudyRevision?: number;
    jobId?: string;
  } = {},
): Promise<Rpc.PersistInput> {
  const interview = options.interview ?? interviewRecord(participant);
  const now = options.now ?? T0;
  return {
    interview,
    fingerprint: await sha256Hex(JSON.stringify({ transcript: interview.transcript, id: interview.id })),
    expectedStudyRevision: options.expectedStudyRevision ?? participant.study.revision,
    allowDisabledLinks: false,
    ratePlan: options.ratePlan ?? [],
    identity: { participantSessionId: participant.sessionId, linkId: participant.linkId },
    consent: {
      participantSessionId: participant.sessionId,
      studyId: participant.study.id,
      studyRevision: options.expectedStudyRevision ?? participant.study.revision,
      consentHash: participant.consentHash,
      now,
    },
    initialAnalysis: frozenInput(participant.study, participant.disclosedTransport),
    initialJobId: options.jobId ?? crypto.randomUUID(),
    now,
  };
}

export function sampleStudy(id = 'demo-study-synthetic'): StoredStudy {
  return {
    id,
    config: studyConfig(id, { name: 'Synthetic sample study' }),
    createdAt: T0 - 7 * DAY,
    updatedAt: T0 - 7 * DAY,
    interviewCount: 2,
    isLocked: true,
    revision: 1,
  };
}

/** Legacy analysis-less fixture: a synthesis in the record, no analysis member. */
export function sampleInterview(studyId: string, id: string, createdAt: number): StoredInterview {
  return {
    id,
    studyId,
    studyName: 'Synthetic sample study',
    participantProfile: { id: `profile-${id}`, fields: [], rawContext: 'Synthetic context', timestamp: createdAt },
    transcript: [{ id: 'm1', role: 'user', content: 'Synthetic sample answer.', timestamp: createdAt }],
    synthesis: {
      statedPreferences: ['Synthetic preference'],
      revealedPreferences: [],
      themes: [{ theme: 'Synthetic theme', frequency: 1 }],
      contradictions: [],
      keyInsights: ['Synthetic insight'],
      bottomLine: 'Synthetic bottom line.',
    },
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    createdAt,
    completedAt: createdAt + 1000,
    status: 'completed',
    studyRevision: 1,
  };
}

export { testEnv };
