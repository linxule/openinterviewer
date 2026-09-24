// WorkspaceStorePort client for the WorkspaceStore Durable Object (Cloudflare
// target). Portable module: it never imports Workers modules; it receives the
// namespace binding as an opaque structural value and uses only Web Crypto.
// Link codes, consent text and budget scope keys are digested here, so raw
// codes and client identities never reach storage.
//
// A thrown RPC is never success: reads map to `unavailable`, mutations to
// `ambiguous` where their union has it (the commit may have happened; callers
// replay with the same identity), otherwise `unavailable`. A reply whose status
// (or hold reason) is outside the operation's closed union is treated the same
// way: it is never passed through to a route.

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
  AggregateInputsPurpose,
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
  MaintenanceState,
  PersistCompletedInterviewInput,
  PersistCompletedInterviewOutcome,
  RecordConsentOutcome,
  SaveAggregateOutcome,
  SeedSampleInput,
  SeedSampleOutcome,
  StoreReadiness,
  StudyListEntry,
  StudyListView,
  StudyLoadResult,
  StudyMutationOutcome,
  VerifyConsentOutcome,
  WorkspaceHoldReason,
} from './types';
import type { AdmissionIdentity } from '../runtime/workerInvocation';
import { normalizeClientAddress } from '../runtime/clientAddress';
import { logRequestEvent } from '../requestLog';

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
/**
 * Serialized (UTF-8 JSON) interview bytes one listInterviews result may
 * assemble in a Worker, across all its pages. More is `too-large` (HTTP 413),
 * never a truncated list. The count maximum alone does not bound memory: 1,000
 * records at the 512,000-byte save cap are about 500 MB. The figure and its
 * sizing evidence are those of MAX_AGGREGATE_INPUT_BYTES (ownedStudies.ts):
 * the live heap is 1.4-1.9x the input bytes, and a list route then holds its
 * JSON response as well, so 16 MiB is the most one request may take of a
 * 128 MB isolate shared with the OpenNext baseline and concurrent requests.
 * A workerd measurement against a deployed Worker remains a remote gate.
 */
export const MAX_LIST_INTERVIEWS_BYTES = 16 * 1024 * 1024;
/**
 * Stored bytes the object may load per listStudies page. A summary page
 * replies with list items projected from what it loaded, so the reply is
 * smaller than the budget; a full page replies with about the budget (the
 * object caps any page at 12 MiB and 1,000 rows).
 */
export const LIST_STUDIES_PAGE_BYTES = 4 * 1024 * 1024;
/**
 * Serialized (UTF-8 JSON) bytes one listStudies result may assemble in a
 * Worker, across all its pages, in either view; more is `too-large` (HTTP
 * 413), never a truncated list. Sized as MAX_LIST_INTERVIEWS_BYTES is. A
 * summary item carries the name (≤ 200 characters), the description
 * (≤ 10,000) and metadata, so 1,000 studies fit unless their descriptions
 * average more than about 16 KB of UTF-8 (roughly 5,500 characters of CJK
 * text). The full view fits only about 16 MiB of whole studies (some 130 at
 * the create body cap).
 */
export const MAX_LIST_STUDIES_BYTES = 16 * 1024 * 1024;

/** One collection page as the object returns it when the request carries `page`. */
type CollectionPage<T> =
  | { status: 'ok'; items: T[]; nextCursor: string | null; count: number }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' };

// ---------- Closed reply unions ----------

/**
 * Every status an operation's reply may carry. Mapped over the union's status
 * member, so the compiler rejects a table that misses or adds one.
 */
type StatusTable<T extends { status: string }> = { readonly [S in T['status']]: true };

const HOLD_REASONS: { readonly [R in WorkspaceHoldReason]: true } = {
  maintenance: true,
  'schema-unsupported': true,
  'workspace-identity-mismatch': true,
  'workspace-uninitialized': true,
  'workspace-unconfigured': true,
  'recovery-epoch-mismatch': true,
};

const MAINTENANCE_STATES: { readonly [S in MaintenanceState]: true } = {
  open: true,
  draining: true,
  frozen: true,
  recovery: true,
};

function isMember(table: object, key: unknown): boolean {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
}

/** A reply in the closed union; a `held` reply must also name a known hold reason. */
function inUnion(table: object): (value: unknown) => boolean {
  return (value) => {
    if (!isOutcome(value) || !isMember(table, value.status)) return false;
    return value.status !== 'held' || isMember(HOLD_REASONS, (value as { reason?: unknown }).reason);
  };
}

const READINESS: StatusTable<StoreReadiness> = { ready: true, unavailable: true, held: true };
const STUDY_LOAD: StatusTable<StudyLoadResult> = { found: true, 'not-found': true, unavailable: true };
const CREATE_STUDY: StatusTable<CreateStudyOutcome> = {
  created: true,
  'key-reuse': true,
  'key-consumed': true,
  conflict: true,
  quota: true,
  held: true,
  unavailable: true,
  ambiguous: true,
};
const STUDY_MUTATION: StatusTable<StudyMutationOutcome> = {
  updated: true,
  conflict: true,
  'not-found': true,
  unavailable: true,
  ambiguous: true,
  'persist-guard': true,
  held: true,
};
const DELETE_STUDY: StatusTable<DeleteStudyOutcome> = {
  deleted: true,
  cancelled: true,
  'not-found': true,
  conflict: true,
  'still-pending': true,
  unavailable: true,
  ambiguous: true,
  held: true,
};
/** The object's link-creation reply: the port union less `ambiguous`, plus the digest collision it retries. */
const CREATE_LINK_REPLY: { readonly [S in Exclude<CreateLinkOutcome['status'], 'ambiguous'> | 'id-collision']: true } = {
  created: true,
  'id-collision': true,
  'quota-exceeded': true,
  'study-not-found': true,
  'links-disabled': true,
  'revision-stale': true,
  held: true,
  unavailable: true,
};
const LINK_LOAD: StatusTable<LinkLoadOutcome> = {
  found: true,
  'not-found': true,
  expired: true,
  revoked: true,
  held: true,
  unavailable: true,
};
const LINK_LIST: StatusTable<LinkListOutcome> = { ok: true, unavailable: true };
const LINK_REVOKE: StatusTable<LinkRevokeOutcome> = {
  revoked: true,
  'already-revoked': true,
  'not-found': true,
  'owner-conflict': true,
  held: true,
  unavailable: true,
  ambiguous: true,
};
const RECORD_CONSENT: StatusTable<RecordConsentOutcome> = { accepted: true, conflict: true, unavailable: true, held: true };
const VERIFY_CONSENT: StatusTable<VerifyConsentOutcome> = { accepted: true, missing: true, mismatch: true, unavailable: true };
const ADMISSION: StatusTable<AdmissionOutcome> = { admitted: true, limited: true, held: true, unavailable: true };
const PERSIST: StatusTable<PersistCompletedInterviewOutcome> = {
  created: true,
  duplicate: true,
  conflict: true,
  'study-not-found': true,
  'links-disabled': true,
  'revision-stale': true,
  'rate-limited': true,
  'persist-guard': true,
  unavailable: true,
  ambiguous: true,
  'link-inactive': true,
  'consent-required': true,
  held: true,
};
const INTERVIEW_LOAD: StatusTable<InterviewLoadResult> = { found: true, 'not-found': true, unavailable: true };
const COLLECTION_PAGE: StatusTable<CollectionPage<unknown>> = { ok: true, 'too-large': true, unavailable: true };
const AGGREGATE_LOAD: StatusTable<AggregateLoadResult> = { found: true, 'not-found': true, unavailable: true };
const SAVE_AGGREGATE: { readonly [S in SaveAggregateOutcome]: true } = {
  saved: true,
  'too-large': true,
  unavailable: true,
  'study-not-found': true,
  held: true,
};
const SEED_SAMPLE: StatusTable<SeedSampleOutcome> = { seeded: true, 'already-seeded': true, held: true, unavailable: true };
const CLEAR_SAMPLE: StatusTable<ClearSampleOutcome> = {
  cleared: true,
  'has-participant-data': true,
  held: true,
  unavailable: true,
  ambiguous: true,
};
const ACCEPT_RETRY: StatusTable<AcceptAnalysisRetryOutcome> = {
  accepted: true,
  'transport-not-disclosed': true,
  existing: true,
  'already-complete': true,
  'state-changed': true,
  'key-conflict': true,
  'not-found': true,
  held: true,
  corrupt: true,
  unavailable: true,
};
const ANALYSIS_STATUS: StatusTable<ReadAnalysisStatusOutcome> = { ok: true, 'not-found': true, corrupt: true, unavailable: true };
const EXPORT_BEGIN: StatusTable<ExportBegin> = { ok: true, empty: true, 'too-large': true, unavailable: true };
const EXPORT_PAGE: StatusTable<ExportPage> = { ok: true, changed: true, unavailable: true };
const EXPORT_SEQUENCE: { readonly [S in Awaited<ReturnType<DurableWorkspaceStorePort['verifyExportSequence']>>]: true } = {
  unchanged: true,
  changed: true,
  unavailable: true,
};
const AGGREGATE_INPUTS: StatusTable<AggregateInputsPage> = { ok: true, unavailable: true };

const acceptReadiness = (value: unknown): boolean => {
  if (!inUnion(READINESS)(value)) return false;
  const { status, maintenance } = value as { status: string; maintenance?: unknown };
  if (status === 'ready') return isMember(MAINTENANCE_STATES, maintenance);
  return status !== 'held' || maintenance === undefined || isMember(MAINTENANCE_STATES, maintenance);
};

const acceptSaveAggregate = (value: unknown): boolean => isMember(SAVE_AGGREGATE, value);

function isCollectionPage(value: unknown): value is CollectionPage<unknown> {
  if (!inUnion(COLLECTION_PAGE)(value)) return false;
  if ((value as { status: string }).status !== 'ok') return true;
  const page = value as { items?: unknown; nextCursor?: unknown; count?: unknown };
  return Array.isArray(page.items)
    && (page.nextCursor === null || typeof page.nextCursor === 'string')
    && Number.isSafeInteger(page.count);
}

function isAggregateInputsPage(value: unknown): value is AggregateInputsPage {
  if (!inUnion(AGGREGATE_INPUTS)(value)) return false;
  if ((value as { status: string }).status !== 'ok') return true;
  const page = value as { interviews?: unknown; nextCursor?: unknown; totalEligible?: unknown };
  return Array.isArray(page.interviews)
    && (page.nextCursor === null || typeof page.nextCursor === 'string')
    && Number.isSafeInteger(page.totalEligible);
}

const encoder = new TextEncoder();

function serializedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

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

  /**
   * `onFailure` answers a thrown RPC and any reply `accept` refuses. A refused
   * reply (version skew or a malformed object reply, not an outage) is logged
   * by operation name only; the reply itself is never logged.
   */
  async function call<T>(method: string, input: unknown, onFailure: T, accept: (value: unknown) => boolean): Promise<T> {
    let result: unknown;
    try {
      // Invoke as a member call: on an RPC stub, `fn.call(...)` would itself
      // be sent as a remote method named "call".
      const target = stub();
      result = input === undefined ? await target[method]() : await target[method](input);
    } catch {
      return onFailure;
    }
    if (accept(result)) return result as T;
    logRequestEvent({ event: 'workspace.store', operation: method, reason: 'unknown-outcome' });
    return onFailure;
  }

  const unavailable = { status: 'unavailable' } as const;
  const ambiguous = { status: 'ambiguous' } as const;

  // Assembled from keyset pages so only the route maximum and the Worker
  // byte ceiling limit a collection, never one RPC response's size. Each
  // page re-counts the scope; the assembled total is checked against the
  // maximum as well. A page never asks for more stored bytes than the
  // ceiling has left, so a refusal holds at most one row past it.
  async function listPaged<T>(
    method: string,
    input: { maximum: number; view?: StudyListView },
    pageBytes: number,
    ceiling: number,
  ): Promise<CollectionLoadResult<T>> {
    const items: T[] = [];
    let cursor: string | null = null;
    let bytes = 0;
    // Every non-final page carries at least one row, which bounds the loop.
    for (let pages = 0; pages <= input.maximum + 1; pages += 1) {
      const maxPageBytes = Math.max(1, Math.min(pageBytes, ceiling - bytes));
      const page: CollectionPage<T> = await call<CollectionPage<T>>(
        method,
        { ...input, page: { cursor, maxPageBytes } },
        unavailable,
        isCollectionPage,
      );
      if (page.status !== 'ok') return page;
      for (const item of page.items) {
        bytes += serializedBytes(item);
        if (bytes > ceiling) return { status: 'too-large', count: page.count, maximum: input.maximum };
        items.push(item);
      }
      if (items.length > input.maximum) return { status: 'too-large', count: items.length, maximum: input.maximum };
      if (page.nextCursor === null) return { status: 'ok', items };
      if (page.nextCursor === cursor) return unavailable;
      cursor = page.nextCursor;
    }
    return unavailable;
  }

  async function consentInput(input: ConsentBinding & { now: number }) {
    return {
      participantSessionId: input.participantSessionId,
      studyId: input.studyId,
      studyRevision: input.studyRevision,
      consentHash: await sha256Hex(input.consentText),
      now: input.now,
      ...(input.disclosedTransport === 'cloudflare-gateway' ? { disclosedTransport: input.disclosedTransport } : {}),
    };
  }

  const store: DurableWorkspaceStorePort = {
    backend: 'durable-object',

    readiness: () => call<StoreReadiness>('readiness', undefined, unavailable, acceptReadiness),

    getStudy: (studyId: string) => call<StudyLoadResult>('getStudy', { studyId }, unavailable, inUnion(STUDY_LOAD)),

    listStudies: <V extends StudyListView>(maximum: number, { view }: { view: V }) =>
      listPaged<StudyListEntry<V>>('listStudies', { maximum, view }, LIST_STUDIES_PAGE_BYTES, MAX_LIST_STUDIES_BYTES),

    createStudy: (input: CreateStudyInput) =>
      call<CreateStudyOutcome>('createStudy', input, ambiguous, inUnion(CREATE_STUDY)),

    replaceStudyConfig: (input) =>
      call<StudyMutationOutcome>('replaceStudyConfig', input, ambiguous, inUnion(STUDY_MUTATION)),

    setStudyLinksEnabled: (input) =>
      call<StudyMutationOutcome>('setStudyLinksEnabled', input, ambiguous, inUnion(STUDY_MUTATION)),

    deleteStudy: (input) =>
      call<DeleteStudyOutcome>(
        'deleteStudy',
        input,
        {
          status: 'ambiguous',
          success: false,
          error: 'Failed to delete study',
          reason: 'ambiguous',
        },
        inUnion(DELETE_STUDY),
      ),

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
          inUnion(CREATE_LINK_REPLY),
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
      return call<LinkLoadOutcome>(
        'getParticipantLink',
        { linkId, now: input.now, purpose: 'exchange' },
        unavailable,
        inUnion(LINK_LOAD),
      );
    },

    async getParticipantLinkById(input: { linkId: string; now: number }): Promise<LinkLoadOutcome> {
      if (typeof input.linkId !== 'string' || !LINK_ID.test(input.linkId)) return { status: 'not-found' };
      return call<LinkLoadOutcome>(
        'getParticipantLink',
        { linkId: input.linkId, now: input.now, purpose: 'session' },
        unavailable,
        inUnion(LINK_LOAD),
      );
    },

    listParticipantLinks: (input) =>
      call<LinkListOutcome>('listParticipantLinks', input, unavailable, inUnion(LINK_LIST)),

    revokeParticipantLink: (input) =>
      call<LinkRevokeOutcome>('revokeParticipantLink', input, ambiguous, inUnion(LINK_REVOKE)),

    async recordConsent(input): Promise<RecordConsentOutcome> {
      try {
        return await call<RecordConsentOutcome>(
          'recordConsent',
          await consentInput(input),
          unavailable,
          inUnion(RECORD_CONSENT),
        );
      } catch {
        return unavailable;
      }
    },

    async verifyConsent(input): Promise<VerifyConsentOutcome> {
      try {
        return await call<VerifyConsentOutcome>(
          'verifyConsent',
          await consentInput(input),
          unavailable,
          inUnion(VERIFY_CONSENT),
        );
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
          inUnion(ADMISSION),
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
        // A reply outside the persist union may follow a commit: ambiguous, like a lost reply.
        return await call<PersistCompletedInterviewOutcome>('persistCompletedInterview', rpcInput, ambiguous, inUnion(PERSIST));
      } catch {
        return unavailable;
      }
    },

    getInterview: (interviewId: string) =>
      call<InterviewLoadResult>('getInterview', { interviewId }, unavailable, inUnion(INTERVIEW_LOAD)),

    listInterviews: (input: ListInterviewsInput) =>
      listPaged<StoredInterview>('listInterviews', input, LIST_INTERVIEWS_PAGE_BYTES, MAX_LIST_INTERVIEWS_BYTES),

    getAggregate: (studyId: string) =>
      call<AggregateLoadResult>('getAggregate', { studyId }, unavailable, inUnion(AGGREGATE_LOAD)),

    saveAggregate: (aggregate: StoredAggregateSynthesis) =>
      call<SaveAggregateOutcome>('saveAggregate', { aggregate, now: Date.now() }, 'unavailable', acceptSaveAggregate),

    seedSampleWorkspace: (input: SeedSampleInput) =>
      call<SeedSampleOutcome>('seedSampleWorkspace', input, unavailable, inUnion(SEED_SAMPLE)),

    clearSampleWorkspace: (input: ClearSampleInput) =>
      call<ClearSampleOutcome>('clearSampleWorkspace', { ...input, now: Date.now() }, ambiguous, inUnion(CLEAR_SAMPLE)),

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
          ...(input.transport === 'cloudflare-gateway' ? { transport: input.transport } : {}),
          now: input.now,
        };
        // An unknown allocation commit is reported as unavailable; the caller
        // replays the same key and body (API-01).
        return await call<AcceptAnalysisRetryOutcome>('acceptAnalysisRetry', rpcInput, unavailable, inUnion(ACCEPT_RETRY));
      } catch {
        return unavailable;
      }
    },

    readAnalysisStatus: (input) =>
      call<ReadAnalysisStatusOutcome>('readAnalysisStatus', input, unavailable, inUnion(ANALYSIS_STATUS)),

    beginExport: (input) => call<ExportBegin>('beginExport', input, unavailable, inUnion(EXPORT_BEGIN)),

    readExportPage: (input) => call<ExportPage>('readExportPage', input, unavailable, inUnion(EXPORT_PAGE)),

    async verifyExportSequence(input): Promise<'unchanged' | 'changed' | 'unavailable'> {
      const outcome = await call<{ status: 'unchanged' | 'changed' | 'unavailable' }>(
        'verifyExportSequence',
        input,
        unavailable,
        inUnion(EXPORT_SEQUENCE),
      );
      return outcome.status;
    },

    readAggregateInputs: (input) => {
      const purpose: AggregateInputsPurpose = input.purpose === 'follow-up' ? 'follow-up' : 'aggregate';
      return call<AggregateInputsPage>(
        'readAggregateInputs',
        {
          studyId: input.studyId,
          studyRevision: input.studyRevision,
          cursor: input.cursor,
          pageSize: input.pageSize,
          maxPageBytes: input.maxPageBytes,
          purpose,
        },
        unavailable,
        isAggregateInputsPage,
      );
    },
  };
  return store;
}

// ---------- Researcher sign-in budget (gap F5) ----------

/**
 * The sign-in budget subject for one admission identity: the full normalized
 * address, IPv4 or IPv6 (RT-07 retains full IPv6 rather than a subnet policy;
 * an IPv6 host rotating through its /64 is bounded by the global window, see
 * DEVIATIONS.md). IPv4-mapped IPv6 normalizes to the IPv4 address. Requests
 * without a usable address share one `unknown` subject and Workers
 * subrequests one `subrequest` subject.
 */
function loginSubject(identity: AdmissionIdentity | null): string {
  if (identity?.kind === 'subrequest') return 'subrequest';
  if (identity?.kind !== 'address') return 'unknown';
  const address = normalizeClientAddress(identity.address);
  return address === null ? 'unknown' : `address:${address}`;
}

/**
 * The sign-in budget's client scope: an HMAC (keyed by RATE_LIMIT_SALT) of the
 * identity's subject (loginSubject), domain-separated from participant budget
 * keys. Neither the `unknown` nor the `subrequest` scope is an unlimited path.
 */
export function loginClientKey(rateLimitSalt: string, identity: AdmissionIdentity | null): Promise<string> {
  return hmacSha256Hex(rateLimitSalt, `login:v1\u0000${loginSubject(identity)}`);
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
