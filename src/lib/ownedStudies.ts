import type { NextResponse } from 'next/server';
import type { RedisPort } from './redisPort';
import { getPlatformClient } from './kvClient';
import { getStudyAuthorityChecked, type StudyAuthorityCheckedResult } from './platformDb';
import { platformKey } from './platformSchema';
import {
  getStudyChecked,
  getStudyInterviewsChecked,
  type CollectionLoadResult,
} from './kv';
import { presentStudyAuthority, type PresentedStudyAuthority } from './researcherContext';
import type { PendingStudyStub, StoredInterview, StoredStudy, StudyWorkspaceItem } from '@/types';
import { logRequestFailure } from './requestLog';
import {
  RESEARCHER_WORKSPACE_HELD_COPY,
  workspaceHeldResponse,
  type WorkspaceHeldCopy,
} from './canonicalStudy';
import type {
  DurableWorkspaceStorePort,
  MaintenanceState,
  StoreReadiness,
  WorkspaceHoldReason,
} from './storage/types';

export const MAX_OWNED_STUDIES = 1_000;

export type OwnedStudyIdLoadResult =
  | { status: 'ok'; studyIds: string[] }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' };

export type OwnedCollectionLoadResult<T> =
  | { status: 'ok'; items: T[]; pendingStudies: PendingStudyStub[] }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' }
  | { status: 'noacct' }
  | { status: 'blocked'; presented: Extract<PresentedStudyAuthority, { ok: false }> };

export type OwnedStudyGateInspection =
  | { status: 'ok'; allowedIds: string[]; pendingStudies: PendingStudyStub[] }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' }
  | { status: 'noacct' }
  | { status: 'blocked'; presented: Extract<PresentedStudyAuthority, { ok: false }> };

function asStudyIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const member of value) {
    if (typeof member !== 'string' || member.length === 0 || member.length > 128) return null;
    ids.push(member);
  }
  return [...new Set(ids)];
}

function blockedFromGate(
  gate: StudyAuthorityCheckedResult,
): Extract<OwnedCollectionLoadResult<never>, { status: 'blocked' | 'noacct' | 'unavailable' }> | null {
  if (gate.status === 'allow' || gate.status === 'live' || gate.status === 'deny' || gate.status === 'notfound') {
    return null;
  }
  if (gate.status === 'noacct') return { status: 'noacct' };
  if (gate.status === 'unavailable' || gate.status === 'ambiguous' || gate.status === 'invalid') {
    return { status: 'unavailable' };
  }
  const presented = presentStudyAuthority(gate, 'researcher');
  if (presented.ok) return { status: 'unavailable' };
  return { status: 'blocked', presented };
}

export async function listOwnedStudyIds(researcherId: string): Promise<OwnedStudyIdLoadResult> {
  try {
    const client = getPlatformClient();
    const key = platformKey(`researcher-studies:${researcherId}`);
    const count = await client.scard(key);
    if (count > MAX_OWNED_STUDIES) {
      return { status: 'too-large', count, maximum: MAX_OWNED_STUDIES };
    }
    const members = asStudyIds(await client.smembers(key));
    if (!members) return { status: 'unavailable' };
    if (members.length > MAX_OWNED_STUDIES) {
      return { status: 'too-large', count: members.length, maximum: MAX_OWNED_STUDIES };
    }
    return { status: 'ok', studyIds: members };
  } catch (error) {
    logRequestFailure({ event: 'platform.unavailable' }, error);
    return { status: 'unavailable' };
  }
}

function pendingStub(studyId: string, phase: string): PendingStudyStub {
  return {
    id: studyId,
    reconciliationPending: true,
    operationId: studyId,
    phase,
  };
}

export async function inspectOwnedStudyGates(
  researcherId: string,
): Promise<OwnedStudyGateInspection> {
  const ids = await listOwnedStudyIds(researcherId);
  if (ids.status !== 'ok') return ids;

  const allowedIds: string[] = [];
  const pendingStudies: PendingStudyStub[] = [];
  for (const studyId of ids.studyIds) {
    const gate = await getStudyAuthorityChecked({
      researcherId,
      studyId,
      purpose: 'read',
    });
    const blocked = blockedFromGate(gate);
    if (blocked) return blocked;
    if (gate.status === 'live') {
      pendingStudies.push(pendingStub(studyId, gate.phase));
      continue;
    }
    if (gate.status === 'allow') allowedIds.push(studyId);
  }

  return { status: 'ok', allowedIds, pendingStudies };
}

export async function loadAllowedStudies(
  studyIds: string[],
  kvClient: RedisPort,
): Promise<OwnedCollectionLoadResult<StoredStudy>> {
  const items: StoredStudy[] = [];
  for (const studyId of studyIds) {
    const loaded = await getStudyChecked(studyId, kvClient);
    if (loaded.status === 'unavailable') return { status: 'unavailable' };
    if (loaded.status === 'found') items.push(loaded.study);
  }
  return { status: 'ok', items, pendingStudies: [] };
}

export async function loadAllowedInterviews(
  studyIds: string[],
  kvClient: RedisPort,
  maximum = MAX_OWNED_STUDIES,
): Promise<OwnedCollectionLoadResult<StoredInterview>> {
  const interviews: StoredInterview[] = [];
  for (const studyId of studyIds) {
    const loaded = await getStudyInterviewsChecked(studyId, kvClient, maximum - interviews.length);
    if (loaded.status === 'unavailable') return { status: 'unavailable' };
    if (loaded.status === 'too-large') {
      return { status: 'too-large', count: interviews.length + loaded.count, maximum };
    }
    interviews.push(...loaded.items);
  }
  interviews.sort((a, b) => b.createdAt - a.createdAt);
  return { status: 'ok', items: interviews, pendingStudies: [] };
}

export async function loadOwnedStudies(
  researcherId: string,
  kvClient: RedisPort,
): Promise<OwnedCollectionLoadResult<StudyWorkspaceItem>> {
  const inspection = await inspectOwnedStudyGates(researcherId);
  if (inspection.status !== 'ok') return inspection;

  const loaded = await loadAllowedStudies(inspection.allowedIds, kvClient);
  if (loaded.status !== 'ok') return loaded;
  return {
    status: 'ok',
    items: [...inspection.pendingStudies, ...loaded.items],
    pendingStudies: inspection.pendingStudies,
  };
}

export async function loadOwnedInterviews(
  researcherId: string,
  kvClient: RedisPort,
  maximum = MAX_OWNED_STUDIES,
): Promise<OwnedCollectionLoadResult<StoredInterview>> {
  const inspection = await inspectOwnedStudyGates(researcherId);
  if (inspection.status !== 'ok') return inspection;

  const loaded = await loadAllowedInterviews(inspection.allowedIds, kvClient, maximum);
  if (loaded.status !== 'ok') return loaded;
  return {
    status: 'ok',
    items: loaded.items,
    pendingStudies: inspection.pendingStudies,
  };
}

export function mapCollectionLoad<T>(
  loaded: CollectionLoadResult<T> | OwnedCollectionLoadResult<T>,
  messages: { unavailable: string; tooLarge: string },
): { ok: true; items: T[]; pendingStudies: PendingStudyStub[] } | { ok: false; status: number; body: Record<string, unknown> } {
  if (loaded.status === 'unavailable') {
    return { ok: false, status: 503, body: { error: messages.unavailable, retryable: true } };
  }
  if (loaded.status === 'too-large') {
    return { ok: false, status: 413, body: { error: messages.tooLarge } };
  }
  if ('status' in loaded && loaded.status === 'noacct') {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }
  if ('status' in loaded && loaded.status === 'blocked') {
    return {
      ok: false,
      status: loaded.presented.statusCode,
      body: {
        error: loaded.presented.error,
        retryable: loaded.presented.retryable,
        ...(loaded.presented.code ? { code: loaded.presented.code } : {}),
        ...(loaded.presented.reason ? { reason: loaded.presented.reason } : {}),
      },
    };
  }
  if (loaded.status === 'ok') {
    return {
      ok: true,
      items: loaded.items,
      pendingStudies: 'pendingStudies' in loaded ? loaded.pendingStudies : [],
    };
  }
  return { ok: false, status: 503, body: { error: messages.unavailable, retryable: true } };
}

export function mapStudyLoad(
  loaded: { status: 'found'; study: StoredStudy } | { status: 'not-found' } | { status: 'unavailable' },
  notFound = 'Study not found',
): { ok: true; study: StoredStudy } | { ok: false; status: number; body: Record<string, unknown> } {
  if (loaded.status === 'unavailable') {
    return {
      ok: false,
      status: 503,
      body: { error: 'Study storage is temporarily unavailable.', retryable: true },
    };
  }
  if (loaded.status === 'not-found') {
    return { ok: false, status: 404, body: { error: notFound } };
  }
  return { ok: true, study: loaded.study };
}

export function mapInterviewLoad(
  loaded: { status: 'found'; interview: StoredInterview } | { status: 'not-found' } | { status: 'unavailable' },
  notFound = 'Interview not found',
): { ok: true; interview: StoredInterview } | { ok: false; status: number; body: Record<string, unknown> } {
  if (loaded.status === 'unavailable') {
    return {
      ok: false,
      status: 503,
      body: { error: 'Interview storage is temporarily unavailable.', retryable: true },
    };
  }
  if (loaded.status === 'not-found') {
    return { ok: false, status: 404, body: { error: notFound } };
  }
  return { ok: true, interview: loaded.interview };
}

// ---------- Durable workspace holds (Cloudflare target) ----------

/**
 * Maintenance states in which a request class may proceed (OPS-01, gap F26).
 * Reads run in every state; researcher mutations only while open. Aggregate
 * synthesis ends in a researcher mutation (the aggregate write), so it is
 * refused outside open before the provider is paid. PAID_CALL_STATES is for
 * paid calls that write nothing (follow-up generation): open or draining.
 */
export const RESEARCHER_READ_STATES: ReadonlyArray<MaintenanceState> = ['open', 'draining', 'frozen', 'recovery'];
export const RESEARCHER_MUTATION_STATES: ReadonlyArray<MaintenanceState> = ['open'];
export const PAID_CALL_STATES: ReadonlyArray<MaintenanceState> = ['open', 'draining'];

/**
 * Hold reasons under which the durable read gate still serves reads: an
 * operator inspects a restored workspace before activating its recovery
 * epoch (cloudflare/workspace/context.ts `gate(ws, 'read')`). Schema,
 * identity and bootstrap holds refuse reads too.
 */
export const READABLE_HOLD_REASONS: ReadonlyArray<WorkspaceHoldReason> = ['recovery-epoch-mismatch'];

/**
 * A readiness result that is not `unavailable` (callers keep their own
 * unavailable bodies) mapped to the held-workspace response
 * (canonicalStudy.workspaceHeldResponse, with the researcher copy unless the
 * route passes its own), or null when the request class may proceed in the
 * current maintenance state.
 */
export function mapReadinessHold(
  readiness: Exclude<StoreReadiness, { status: 'unavailable' }>,
  allowed: ReadonlyArray<MaintenanceState>,
  route: string,
  copy: WorkspaceHeldCopy = RESEARCHER_WORKSPACE_HELD_COPY,
): NextResponse | null {
  if (readiness.status === 'held') return workspaceHeldResponse({ route, reason: readiness.reason, ...copy });
  return allowed.includes(readiness.maintenance)
    ? null
    : workspaceHeldResponse({ route, reason: 'maintenance', ...copy });
}

/**
 * mapReadinessHold for a researcher read: every maintenance state and a
 * recovery-epoch hold may read (as the durable read gate does); the other
 * holds refuse.
 */
export function mapReadReadinessHold(
  readiness: Exclude<StoreReadiness, { status: 'unavailable' }>,
  route: string,
  copy: WorkspaceHeldCopy = RESEARCHER_WORKSPACE_HELD_COPY,
): NextResponse | null {
  if (readiness.status === 'held' && READABLE_HOLD_REASONS.includes(readiness.reason)) return null;
  return mapReadinessHold(readiness, RESEARCHER_READ_STATES, route, copy);
}

// ---------- Bounded aggregate/follow-up inputs (Cloudflare target, RT-09) ----------

/** The route ceiling on aggregate/follow-up inputs, shared with the Redis path's 1,000-record read. */
export const MAX_AGGREGATE_INTERVIEWS = 1_000;
/**
 * Serialized (UTF-8 JSON) interview bytes one aggregate request may assemble
 * in a Worker. Larger inputs are refused with AGGREGATE_INPUT_TOO_LARGE, never
 * truncated. Sizing evidence (V8 heap proxy in Node, the real route path with
 * structured-clone pages and the real prompt builder): the live heap at the
 * provider call is 1.4-1.9x the input bytes (about 43 MiB for 23 MiB of short
 * ASCII turns). One 128 MB isolate serves concurrent requests on top of the
 * OpenNext baseline, so 16 MiB (about 30 MiB live, plus one transient 4 MiB
 * page, up to twice that as UTF-16 in RPC transit) keeps a single aggregate
 * request under a quarter of the isolate. A workerd measurement against a
 * deployed Worker remains a remote gate.
 */
export const MAX_AGGREGATE_INPUT_BYTES = 16 * 1024 * 1024;
export const AGGREGATE_INPUT_PAGE_BYTES = 4 * 1024 * 1024;
const AGGREGATE_INPUT_PAGE_SIZE = 100;

export type EligibleInputsPass = 'done' | 'stopped' | 'too-large' | 'unavailable';

/**
 * Pages the durable store's current-revision analyzed interviews for one
 * study (newest first, like the Redis collection), handing each page's
 * eligible records to `visit`; `visit` returns false to stop early. The
 * eligibility predicate repeats the Redis route filter (same study, current
 * revision, a synthesis). The count ceiling matches the Redis path, which
 * refuses a study holding more than MAX_AGGREGATE_INTERVIEWS interviews of any
 * revision or analysis state: the study's stored interview count (the durable
 * object keeps it equal to its interview rows) is checked before any page is
 * read, and more than MAX_AGGREGATE_INTERVIEWS eligible records met while
 * paging (interviews saved meanwhile) is `too-large` too.
 *
 * `purpose` names the paid route the inputs feed; the object fences each page
 * like that route (aggregate: open only; follow-up: open or draining, gap
 * F26), so a maintenance transition after the route's readiness check still
 * refuses before the provider is paid. It defaults to the stricter aggregate.
 */
export async function forEachEligibleAggregateInput(
  store: DurableWorkspaceStorePort,
  study: StoredStudy,
  visit: (interviews: StoredInterview[]) => boolean,
  purpose: 'aggregate' | 'follow-up' = 'aggregate',
): Promise<EligibleInputsPass> {
  if (study.interviewCount > MAX_AGGREGATE_INTERVIEWS) return 'too-large';
  let cursor: string | null = null;
  let seen = 0;
  // Every non-final page carries at least one row, which bounds the loop.
  for (let pages = 0; pages <= MAX_AGGREGATE_INTERVIEWS + 1; pages += 1) {
    const page = await store.readAggregateInputs({
      studyId: study.id,
      studyRevision: study.revision,
      cursor,
      pageSize: AGGREGATE_INPUT_PAGE_SIZE,
      maxPageBytes: AGGREGATE_INPUT_PAGE_BYTES,
      purpose,
    });
    if (page.status !== 'ok' || !Array.isArray(page.interviews)) return 'unavailable';
    if (page.totalEligible > MAX_AGGREGATE_INTERVIEWS) return 'too-large';
    seen += page.interviews.length;
    if (seen > MAX_AGGREGATE_INTERVIEWS) return 'too-large';
    const eligible = page.interviews.filter(
      interview => interview.studyId === study.id
        && interview.studyRevision === study.revision
        && Boolean(interview.synthesis),
    );
    if (!visit(eligible)) return 'stopped';
    if (page.nextCursor === null) return 'done';
    if (page.interviews.length === 0 || page.nextCursor === cursor) return 'unavailable';
    cursor = page.nextCursor;
  }
  return 'unavailable';
}

export type DurableAggregateInputsResult =
  | { status: 'ok'; interviews: StoredInterview[] }
  | { status: 'too-large' }
  | { status: 'input-too-large' }
  | { status: 'unavailable' };

/** Assembles every eligible aggregate input within MAX_AGGREGATE_INPUT_BYTES. */
export async function loadDurableAggregateInputs(
  store: DurableWorkspaceStorePort,
  study: StoredStudy,
): Promise<DurableAggregateInputsResult> {
  const encoder = new TextEncoder();
  const interviews: StoredInterview[] = [];
  let bytes = 0;
  const pass = await forEachEligibleAggregateInput(store, study, page => {
    for (const interview of page) {
      bytes += encoder.encode(JSON.stringify(interview)).byteLength;
      if (bytes > MAX_AGGREGATE_INPUT_BYTES) return false;
      interviews.push(interview);
    }
    return true;
  });
  if (pass === 'stopped') return { status: 'input-too-large' };
  if (pass === 'done') return { status: 'ok', interviews };
  return { status: pass };
}

export function aggregateInputTooLargeBody(): Record<string, unknown> {
  return {
    error: 'The analyzed interviews in this study are too large for an interactive aggregate analysis.',
    code: 'AGGREGATE_INPUT_TOO_LARGE',
  };
}
