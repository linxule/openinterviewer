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
