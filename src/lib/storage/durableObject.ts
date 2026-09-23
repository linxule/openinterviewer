// WorkspaceStorePort client for the WorkspaceStore Durable Object (Cloudflare
// target). Portable module: it never imports Workers modules; it receives the
// namespace binding as an opaque structural value and uses only Web Crypto.
// Link codes, consent text and budget scope keys are digested here, so raw
// codes and client identities never reach storage.
//
// A thrown RPC is never success: reads map to `unavailable`, mutations to
// `ambiguous` where their union has it (the commit may have happened; callers
// replay with the same identity), otherwise `unavailable`.

import type { StoredAggregateSynthesis, StoredInterview, StoredStudy } from '@/types';
import type {
  AcceptAnalysisRetryInput,
  AcceptAnalysisRetryOutcome,
  ReadAnalysisStatusOutcome,
} from './analysisProtocol';
import type {
  AdmissionInput,
  AdmissionOutcome,
  AggregateInputsPage,
  AggregateLoadResult,
  ClearSampleInput,
  ClearSampleOutcome,
  CollectionLoadResult,
  ConsentBinding,
  CreateLinkInput,
  CreateLinkOutcome,
  CreateStudyInput,
  CreateStudyOutcome,
  DeleteStudyOutcome,
  DurableWorkspaceStorePort,
  ExportBegin,
  ExportPage,
  InterviewLoadResult,
  LinkListOutcome,
  LoginAttemptBudgetPort,
  LoginBudgetAdmitOutcome,
  LoginBudgetInput,
  LoginBudgetRefundOutcome,
  LinkLoadOutcome,
  LinkRevokeOutcome,
  ListInterviewsInput,
  PersistCompletedInterviewInput,
  PersistCompletedInterviewOutcome,
  RecordConsentOutcome,
  SaveAggregateOutcome,
  SeedSampleInput,
  SeedSampleOutcome,
  StoreReadiness,
  StudyLoadResult,
  StudyMutationOutcome,
  VerifyConsentOutcome,
} from './types';
import type { AdmissionIdentity } from '../runtime/workerInvocation';

export type DurableWorkspaceConfig = {
  /** env.WORKSPACE_STORE (DurableObjectNamespace). */
  namespace: unknown;
  workspaceId: string;
  /** Empty means no jurisdiction restriction (required locally). */
  jurisdiction: '' | 'eu' | 'fedramp';
  /** RATE_LIMIT_SALT: salts budget scope keys before they reach storage. */
  rateLimitSalt: string;
};

type RpcMethod = (input?: unknown) => Promise<unknown>;
type WorkspaceStub = Record<string, RpcMethod>;
type NamespaceLike = {
  getByName(name: string): WorkspaceStub;
  jurisdiction?(jurisdiction: string): NamespaceLike;
};

const LINK_CODE = /^[A-Za-z0-9_-]{43}$/;
const LINK_ID = /^[a-f0-9]{64}$/;
const LINK_CODE_BYTES = 32;
/** Stored bytes requested per listInterviews page; the object caps it at its RPC-safe maximum. */
export const LIST_INTERVIEWS_PAGE_BYTES = 12 * 1024 * 1024;

/** One listInterviews page as the object returns it when the request carries `page`. */
type InterviewListPage =
  | { status: 'ok'; items: StoredInterview[]; nextCursor: string | null; count: number }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' };

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

/** 32 random bytes as unpadded base64url: always 43 characters. */
export function mintParticipantLinkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LINK_CODE_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The scoped digest an analysis retry receipt is keyed by (JOB-04). */
export function analysisRequestKeyDigest(parts: {
  workspaceId: string;
  studyId: string;
  interviewId: string;
  rawIdempotencyKey: string;
}): Promise<string> {
  return sha256Hex([parts.workspaceId, parts.studyId, parts.interviewId, parts.rawIdempotencyKey].join('\u0000'));
}

export function analysisRequestFingerprint(expectedGeneration: number): Promise<string> {
  return sha256Hex(`analysis-retry:v2\u0000${expectedGeneration}`);
}

function isOutcome(value: unknown): value is { status: string } {
  return value !== null && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'string';
}

function isInterviewListPage(value: unknown): value is InterviewListPage {
  if (!isOutcome(value)) return false;
  if (value.status !== 'ok') return true;
  const page = value as { items?: unknown; nextCursor?: unknown };
  return Array.isArray(page.items) && (page.nextCursor === null || typeof page.nextCursor === 'string');
}

export function createDurableWorkspaceStore(config: DurableWorkspaceConfig): DurableWorkspaceStorePort {
  // A fresh stub per operation: a stub that has seen exceptions can be broken.
  function stub(): WorkspaceStub {
    const namespace = config.namespace as NamespaceLike;
    if (config.jurisdiction) {
      if (typeof namespace.jurisdiction !== 'function') throw new Error('Workspace namespace has no jurisdiction support');
      return namespace.jurisdiction(config.jurisdiction).getByName(config.workspaceId);
    }
    return namespace.getByName(config.workspaceId);
  }

  async function call<T>(method: string, input: unknown, onFailure: T, accept: (value: unknown) => boolean = isOutcome): Promise<T> {
    try {
      // Invoke as a member call: on an RPC stub, `fn.call(...)` would itself
      // be sent as a remote method named "call".
      const target = stub();
      const result = input === undefined ? await target[method]() : await target[method](input);
      return accept(result) ? (result as T) : onFailure;
    } catch {
      return onFailure;
    }
  }

  const unavailable = { status: 'unavailable' } as const;
  const ambiguous = { status: 'ambiguous' } as const;

  async function consentInput(input: ConsentBinding & { now: number }) {
    return {
      participantSessionId: input.participantSessionId,
      studyId: input.studyId,
      studyRevision: input.studyRevision,
      consentHash: await sha256Hex(input.consentText),
      now: input.now,
    };
  }

  const store: DurableWorkspaceStorePort = {
    backend: 'durable-object',

    readiness: () => call<StoreReadiness>('readiness', undefined, unavailable),

    getStudy: (studyId: string) => call<StudyLoadResult>('getStudy', { studyId }, unavailable),

    listStudies: (maximum: number) =>
      call<CollectionLoadResult<StoredStudy>>('listStudies', { maximum }, unavailable),

    createStudy: (input: CreateStudyInput) => call<CreateStudyOutcome>('createStudy', input, ambiguous),

    replaceStudyConfig: (input) => call<StudyMutationOutcome>('replaceStudyConfig', input, ambiguous),

    setStudyLinksEnabled: (input) => call<StudyMutationOutcome>('setStudyLinksEnabled', input, ambiguous),

    deleteStudy: (input) =>
      call<DeleteStudyOutcome>('deleteStudy', input, {
        status: 'ambiguous',
        success: false,
        error: 'Failed to delete study',
        reason: 'ambiguous',
      }),

    async createParticipantLink(input: CreateLinkInput): Promise<CreateLinkOutcome> {
      // One retry with a fresh code on a (practically impossible) digest collision.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const code = mintParticipantLinkCode();
        let linkId: string;
        try {
          linkId = await sha256Hex(code);
        } catch {
          return unavailable;
        }
        const outcome = await call<{ status: string; link?: unknown } | typeof ambiguous>(
          'createParticipantLink',
          {
            linkId,
            studyId: input.studyId,
            studyRevision: input.studyRevision,
            expiresAt: input.expiresAt,
            now: input.now,
          },
          ambiguous,
        );
        if (outcome.status === 'id-collision') continue;
        if (outcome.status === 'created') {
          return { status: 'created', code, link: (outcome as Extract<CreateLinkOutcome, { status: 'created' }>).link };
        }
        return outcome as CreateLinkOutcome;
      }
      return unavailable;
    },

    async resolveParticipantLinkByCode(input: { code: string; now: number; purpose: 'exchange' }): Promise<LinkLoadOutcome> {
      if (typeof input.code !== 'string' || !LINK_CODE.test(input.code)) return { status: 'not-found' };
      let linkId: string;
      try {
        linkId = await sha256Hex(input.code);
      } catch {
        return unavailable;
      }
      return call<LinkLoadOutcome>('getParticipantLink', { linkId, now: input.now, purpose: 'exchange' }, unavailable);
    },

    async getParticipantLinkById(input: { linkId: string; now: number }): Promise<LinkLoadOutcome> {
      if (typeof input.linkId !== 'string' || !LINK_ID.test(input.linkId)) return { status: 'not-found' };
      return call<LinkLoadOutcome>(
        'getParticipantLink',
        { linkId: input.linkId, now: input.now, purpose: 'session' },
        unavailable,
      );
    },

    listParticipantLinks: (input) => call<LinkListOutcome>('listParticipantLinks', input, unavailable),

    revokeParticipantLink: (input) => call<LinkRevokeOutcome>('revokeParticipantLink', input, ambiguous),

    async recordConsent(input): Promise<RecordConsentOutcome> {
      try {
        return await call<RecordConsentOutcome>('recordConsent', await consentInput(input), unavailable);
      } catch {
        return unavailable;
      }
    },

    async verifyConsent(input): Promise<VerifyConsentOutcome> {
      try {
        return await call<VerifyConsentOutcome>('verifyConsent', await consentInput(input), unavailable);
      } catch {
        return unavailable;
      }
    },

    async admitParticipantRequest(input: AdmissionInput): Promise<AdmissionOutcome> {
      try {
        const counters = await Promise.all(
          input.counters.map(async (counter) => ({
            key: await hmacSha256Hex(config.rateLimitSalt, counter.key),
            maximum: counter.maximum,
            windowSeconds: counter.windowSeconds,
          })),
        );
        return await call<AdmissionOutcome>(
          'admitParticipantRequest',
          { operation: input.operation, counters, now: input.now },
          unavailable,
        );
      } catch {
        return unavailable;
      }
    },

    async persistCompletedInterview(input: PersistCompletedInterviewInput): Promise<PersistCompletedInterviewOutcome> {
      // The durable backend re-verifies consent and needs the initial job's frozen inputs.
      if (!input.consent || !input.initialAnalysis) return unavailable;
      try {
        const { consent, ...rest } = input;
        const rpcInput = {
          ...rest,
          consent: await consentInput({ ...consent, now: input.now }),
          initialJobId: crypto.randomUUID(),
        };
        return await call<PersistCompletedInterviewOutcome>('persistCompletedInterview', rpcInput, ambiguous);
      } catch {
        return unavailable;
      }
    },

    getInterview: (interviewId: string) => call<InterviewLoadResult>('getInterview', { interviewId }, unavailable),

    // Assembled from keyset pages so only the route maximum limits a
    // collection, never one RPC response's size. Each page re-counts the
    // scope; the assembled total is checked against the maximum as well.
    async listInterviews(input: ListInterviewsInput): Promise<CollectionLoadResult<StoredInterview>> {
      const items: StoredInterview[] = [];
      let cursor: string | null = null;
      // Every non-final page carries at least one row, which bounds the loop.
      for (let pages = 0; pages <= input.maximum + 1; pages += 1) {
        const page: InterviewListPage = await call<InterviewListPage>(
          'listInterviews',
          { ...input, page: { cursor, maxPageBytes: LIST_INTERVIEWS_PAGE_BYTES } },
          unavailable,
          isInterviewListPage,
        );
        if (page.status !== 'ok') return page;
        for (const item of page.items) items.push(item);
        if (items.length > input.maximum) return { status: 'too-large', count: items.length, maximum: input.maximum };
        if (page.nextCursor === null) return { status: 'ok', items };
        if (page.nextCursor === cursor) return unavailable;
        cursor = page.nextCursor;
      }
      return unavailable;
    },

    getAggregate: (studyId: string) => call<AggregateLoadResult>('getAggregate', { studyId }, unavailable),

    saveAggregate: (aggregate: StoredAggregateSynthesis) =>
      call<SaveAggregateOutcome>(
        'saveAggregate',
        { aggregate, now: Date.now() },
        'unavailable',
        (value) => typeof value === 'string',
      ),

    seedSampleWorkspace: (input: SeedSampleInput) => call<SeedSampleOutcome>('seedSampleWorkspace', input, unavailable),

    clearSampleWorkspace: (input: ClearSampleInput) =>
      call<ClearSampleOutcome>('clearSampleWorkspace', { ...input, now: Date.now() }, ambiguous),

    async acceptAnalysisRetry(input): Promise<AcceptAnalysisRetryOutcome> {
      try {
        const rpcInput: AcceptAnalysisRetryInput = {
          studyId: input.studyId,
          interviewId: input.interviewId,
          requestKeyDigest: await analysisRequestKeyDigest({
            workspaceId: config.workspaceId,
            studyId: input.studyId,
            interviewId: input.interviewId,
            rawIdempotencyKey: input.rawIdempotencyKey,
          }),
          requestFingerprint: await analysisRequestFingerprint(input.expectedGeneration),
          expectedGeneration: input.expectedGeneration,
          input: input.input,
          now: input.now,
        };
        // An unknown allocation commit is reported as unavailable; the caller
        // replays the same key and body (API-01).
        return await call<AcceptAnalysisRetryOutcome>('acceptAnalysisRetry', rpcInput, unavailable);
      } catch {
        return unavailable;
      }
    },

    readAnalysisStatus: (input) => call<ReadAnalysisStatusOutcome>('readAnalysisStatus', input, unavailable),

    beginExport: (input) => call<ExportBegin>('beginExport', input, unavailable),

    readExportPage: (input) => call<ExportPage>('readExportPage', input, unavailable),

    async verifyExportSequence(input): Promise<'unchanged' | 'changed' | 'unavailable'> {
      const outcome = await call<{ status: string }>('verifyExportSequence', input, unavailable);
      return outcome.status === 'unchanged' || outcome.status === 'changed' ? outcome.status : 'unavailable';
    },

    readAggregateInputs: (input) => call<AggregateInputsPage>('readAggregateInputs', input, unavailable),
  };
  return store;
}

// ---------- Researcher sign-in budget (gap F5) ----------

/**
 * The sign-in budget's client scope: an HMAC (keyed by RATE_LIMIT_SALT) of the
 * admission identity, domain-separated from participant budget keys. Requests
 * without a usable address share one `unknown` scope and Workers subrequests
 * one `subrequest` scope; neither is ever an unlimited path.
 */
export function loginClientKey(rateLimitSalt: string, identity: AdmissionIdentity | null): Promise<string> {
  const subject = identity?.kind === 'address'
    ? `address:${identity.address}`
    : identity?.kind === 'subrequest'
      ? 'subrequest'
      : 'unknown';
  return hmacSha256Hex(rateLimitSalt, `login:v1\u0000${subject}`);
}

function isRetryAfter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Client for the WorkspaceStore sign-in budget RPCs. A thrown RPC, a hold or
 * an unexpected reply is `unavailable`: the route fails closed on admission.
 */
export function createDurableLoginBudget(config: DurableWorkspaceConfig): LoginAttemptBudgetPort {
  function stub(): WorkspaceStub {
    const namespace = config.namespace as NamespaceLike;
    if (config.jurisdiction) {
      if (typeof namespace.jurisdiction !== 'function') throw new Error('Workspace namespace has no jurisdiction support');
      return namespace.jurisdiction(config.jurisdiction).getByName(config.workspaceId);
    }
    return namespace.getByName(config.workspaceId);
  }

  async function invoke(method: 'admitLoginAttempt' | 'refundLoginAttempt', input: LoginBudgetInput): Promise<unknown> {
    const clientKey = await loginClientKey(config.rateLimitSalt, input.identity);
    // Member call, as in createDurableWorkspaceStore.
    return stub()[method]({ clientKey, now: input.now });
  }

  return {
    async admitLoginAttempt(input: LoginBudgetInput): Promise<LoginBudgetAdmitOutcome> {
      try {
        const outcome = await invoke('admitLoginAttempt', input);
        if (!isOutcome(outcome)) return { status: 'unavailable' };
        if (outcome.status === 'admitted') return { status: 'admitted' };
        if (outcome.status === 'limited') {
          const limited = outcome as { scope?: unknown; retryAfterSeconds?: unknown };
          if ((limited.scope === 'client' || limited.scope === 'global') && isRetryAfter(limited.retryAfterSeconds)) {
            return { status: 'limited', scope: limited.scope, retryAfterSeconds: limited.retryAfterSeconds };
          }
        }
        return { status: 'unavailable' };
      } catch {
        return { status: 'unavailable' };
      }
    },

    async refundLoginAttempt(input: LoginBudgetInput): Promise<LoginBudgetRefundOutcome> {
      try {
        const outcome = await invoke('refundLoginAttempt', input);
        return isOutcome(outcome) && outcome.status === 'refunded' ? { status: 'refunded' } : { status: 'unavailable' };
      } catch {
        return { status: 'unavailable' };
      }
    },
  };
}
