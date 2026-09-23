// Participant links, consent and greeting/interview admission budgets
// (ST-03/06). Link ids are sha256 digests minted by the caller: no raw
// participant code is ever stored here. Expiry is absolute and checked at
// access, independent of cleanup.

import type * as Port from '../../src/lib/storage/types';
import type { ParticipantLinkMetadata, ParticipantLinkRecord } from '../../src/lib/participantLinks';
import type { ParticipantConsentRecord } from '../../src/lib/participantConsent';
import type * as Rpc from './rpcTypes';
import { gate, type OperationClass, type WorkspaceContext } from './context';
import {
  decodeStudyRow,
  isHex64,
  isPlainObject,
  isRevision,
  isSafeTime,
  logCorruptRecord,
  logStorageFailure,
  readStudyRow,
  STUDY_ID,
} from './studies';

/** Unexpired, unrevoked links per workspace (Redis also counted revoked and expired-but-unpruned links). */
export const MAX_ACTIVE_LINKS = 1_000;
export const CONSENT_TTL_MS = 4 * 60 * 60 * 1000;

const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const CONSENT_STUDY_ID = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_ADMISSION_COUNTERS = 8;
const MAX_WINDOW_SECONDS = 31 * 24 * 60 * 60;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------- Link rows ----------

type LinkRow = {
  id: string;
  study_id: string;
  study_revision: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
};

const LINK_COLUMNS = 'id, study_id, study_revision, created_at, expires_at, revoked_at';

function decodeLinkRow(row: LinkRow): ParticipantLinkRecord | null {
  if (
    !isHex64(row.id)
    || typeof row.study_id !== 'string'
    || row.study_id.length === 0
    || !isRevision(row.study_revision)
    || !isSafeTime(row.created_at)
    || (row.expires_at !== null && !isSafeTime(row.expires_at))
    || (row.revoked_at !== null && !isSafeTime(row.revoked_at))
  ) {
    return null;
  }
  return {
    id: row.id,
    version: 1,
    studyId: row.study_id,
    studyRevision: row.study_revision,
    researcherId: null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function readLinkRow(ws: WorkspaceContext, linkId: string): LinkRow | null {
  return ws.sql.exec<LinkRow>(`SELECT ${LINK_COLUMNS} FROM participant_links WHERE id = ?`, linkId).toArray()[0] ?? null;
}

export type LinkState =
  | { status: 'found'; link: ParticipantLinkRecord }
  | { status: 'not-found' }
  | { status: 'expired' }
  | { status: 'revoked' }
  | { status: 'corrupt' };

/** Resolve a link at `now`: revocation is checked before expiry, as on Redis. */
export function resolveLink(ws: WorkspaceContext, linkId: string, now: number): LinkState {
  const row = readLinkRow(ws, linkId);
  if (!row) return { status: 'not-found' };
  const link = decodeLinkRow(row);
  if (!link || link.id !== linkId) return { status: 'corrupt' };
  if (link.revokedAt !== null) return { status: 'revoked' };
  if (link.expiresAt !== null && link.expiresAt <= now) return { status: 'expired' };
  return { status: 'found', link };
}

export async function createParticipantLink(
  ws: WorkspaceContext,
  input: Rpc.CreateLinkRecordInput,
): Promise<Rpc.CreateLinkRecordOutcome> {
  try {
    if (
      !isHex64(input?.linkId)
      || typeof input.studyId !== 'string'
      || !STUDY_ID.test(input.studyId)
      || !isRevision(input.studyRevision)
      || !isSafeTime(input.now)
      || (input.expiresAt !== null && (!isSafeTime(input.expiresAt) || input.expiresAt <= input.now))
    ) {
      return { status: 'unavailable' };
    }
    const { linkId, studyId, studyRevision, expiresAt, now } = input;
    return ws.storage.transactionSync((): Rpc.CreateLinkRecordOutcome => {
      const checked = gate(ws, 'researcher-mutation');
      if (!checked.ok) return { status: 'held', reason: checked.reason };
      const row = readStudyRow(ws, studyId);
      if (!row) return { status: 'study-not-found' };
      const study = decodeStudyRow(row);
      if (!study) {
        logCorruptRecord('createParticipantLink');
        return { status: 'unavailable' };
      }
      if (study.config.linksEnabled === false) return { status: 'links-disabled' };
      if (study.revision !== studyRevision) return { status: 'revision-stale' };
      const active = ws.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM participant_links
            WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
          now,
        )
        .one().n;
      if (active >= MAX_ACTIVE_LINKS) return { status: 'quota-exceeded' };
      if (readLinkRow(ws, linkId)) return { status: 'id-collision' };
      ws.sql.exec(
        `INSERT INTO participant_links (id, study_id, study_revision, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        linkId,
        studyId,
        studyRevision,
        now,
        expiresAt,
      );
      return {
        status: 'created',
        link: {
          id: linkId,
          version: 1,
          studyId,
          studyRevision,
          researcherId: null,
          createdAt: now,
          expiresAt,
          revokedAt: null,
        },
      };
    });
  } catch (error) {
    logStorageFailure('createParticipantLink', error);
    return { status: 'unavailable' };
  }
}

const LINK_PURPOSE_CLASS: Record<Rpc.GetLinkInput['purpose'], OperationClass> = {
  exchange: 'participant-entry',
  session: 'participant-session',
  researcher: 'read',
};

export async function getParticipantLink(ws: WorkspaceContext, input: Rpc.GetLinkInput): Promise<Port.LinkLoadOutcome> {
  try {
    const purpose = input?.purpose;
    const operation = Object.prototype.hasOwnProperty.call(LINK_PURPOSE_CLASS, purpose)
      ? LINK_PURPOSE_CLASS[purpose]
      : undefined;
    if (!operation || !isSafeTime(input.now) || typeof input.linkId !== 'string') return { status: 'unavailable' };
    return ws.storage.transactionSync((): Port.LinkLoadOutcome => {
      const checked = gate(ws, operation);
      if (!checked.ok) return { status: 'held', reason: checked.reason };
      if (!isHex64(input.linkId)) return { status: 'not-found' };
      const state = resolveLink(ws, input.linkId, input.now);
      if (state.status === 'corrupt') {
        logCorruptRecord('getParticipantLink');
        return { status: 'unavailable' };
      }
      return state;
    });
  } catch (error) {
    logStorageFailure('getParticipantLink', error);
    return { status: 'unavailable' };
  }
}

export async function listParticipantLinks(ws: WorkspaceContext, input: Rpc.ListLinksInput): Promise<Port.LinkListOutcome> {
  try {
    if (
      typeof input?.studyId !== 'string'
      || !STUDY_ID.test(input.studyId)
      || typeof input.maximum !== 'number'
      || !Number.isSafeInteger(input.maximum)
      || !isSafeTime(input.now)
    ) {
      return { status: 'unavailable' };
    }
    const maximum = Math.max(1, Math.min(input.maximum, MAX_ACTIVE_LINKS));
    return ws.storage.transactionSync((): Port.LinkListOutcome => {
      if (!gate(ws, 'read').ok) return { status: 'unavailable' };
      // Revoked links stay listed; expired ones do not (Redis parity).
      const rows = ws.sql
        .exec<LinkRow>(
          `SELECT ${LINK_COLUMNS} FROM participant_links
            WHERE study_id = ? AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY created_at DESC, id ASC
            LIMIT ?`,
          input.studyId,
          input.now,
          maximum + 1,
        )
        .toArray();
      const links: ParticipantLinkMetadata[] = [];
      for (const row of rows.slice(0, maximum)) {
        const link = decodeLinkRow(row);
        if (!link) {
          logCorruptRecord('listParticipantLinks');
          return { status: 'unavailable' };
        }
        links.push({
          id: link.id,
          studyRevision: link.studyRevision,
          createdAt: link.createdAt,
          expiresAt: link.expiresAt,
          revokedAt: link.revokedAt,
        });
      }
      return { status: 'ok', links, truncated: rows.length > maximum };
    });
  } catch (error) {
    logStorageFailure('listParticipantLinks', error);
    return { status: 'unavailable' };
  }
}

export async function revokeParticipantLink(ws: WorkspaceContext, input: Rpc.RevokeLinkInput): Promise<Port.LinkRevokeOutcome> {
  try {
    if (typeof input?.studyId !== 'string' || typeof input.linkId !== 'string' || !isSafeTime(input.now)) {
      return { status: 'unavailable' };
    }
    const { studyId, linkId, now } = input;
    return ws.storage.transactionSync((): Port.LinkRevokeOutcome => {
      const checked = gate(ws, 'researcher-mutation');
      if (!checked.ok) return { status: 'held', reason: checked.reason };
      if (!isHex64(linkId)) return { status: 'not-found' };
      const row = readLinkRow(ws, linkId);
      if (!row) return { status: 'not-found' };
      const link = decodeLinkRow(row);
      if (!link) {
        logCorruptRecord('revokeParticipantLink');
        return { status: 'unavailable' };
      }
      // Same order as the Redis script: owner, then expiry, then revocation.
      if (link.studyId !== studyId) return { status: 'owner-conflict' };
      if (link.expiresAt !== null && link.expiresAt <= now) return { status: 'not-found' };
      if (link.revokedAt !== null) return { status: 'already-revoked' };
      ws.sql.exec(`UPDATE participant_links SET revoked_at = ? WHERE id = ?`, now, linkId);
      return { status: 'revoked', revokedAt: now };
    });
  } catch (error) {
    logStorageFailure('revokeParticipantLink', error);
    return { status: 'unavailable' };
  }
}

// ---------- Consent ----------

function isValidConsentInput(input: Rpc.ConsentInput | undefined): input is Rpc.ConsentInput {
  return isPlainObject(input)
    && typeof input.participantSessionId === 'string'
    && SESSION_ID.test(input.participantSessionId)
    && typeof input.studyId === 'string'
    && CONSENT_STUDY_ID.test(input.studyId)
    && isRevision(input.studyRevision)
    && isHex64(input.consentHash)
    && isSafeTime(input.now)
    && input.now > 0;
}

function parseConsentRecord(json: string): ParticipantConsentRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (
    parsed.version !== 1
    || typeof parsed.participantSessionId !== 'string'
    || !SESSION_ID.test(parsed.participantSessionId)
    || typeof parsed.studyId !== 'string'
    || !CONSENT_STUDY_ID.test(parsed.studyId)
    || !isRevision(parsed.studyRevision)
    || !isHex64(parsed.consentHash)
    || !isSafeTime(parsed.acceptedAt)
    || parsed.acceptedAt <= 0
  ) {
    return null;
  }
  return parsed as unknown as ParticipantConsentRecord;
}

export function consentMatches(record: ParticipantConsentRecord, binding: Rpc.ConsentInput): boolean {
  return record.participantSessionId === binding.participantSessionId
    && record.studyId === binding.studyId
    && record.studyRevision === binding.studyRevision
    && record.consentHash === binding.consentHash;
}

/**
 * The unexpired consent stored for a session digest. `malformed` is reported
 * separately so callers keep the Redis mapping (missing / conflict).
 */
export function readConsent(
  ws: WorkspaceContext,
  sessionDigest: string,
  now: number,
): ParticipantConsentRecord | 'absent' | 'malformed' {
  const row = ws.sql
    .exec<{ record_json: string; expires_at: number }>(
      `SELECT record_json, expires_at FROM consents WHERE session_digest = ?`,
      sessionDigest,
    )
    .toArray()[0];
  if (!row || row.expires_at <= now) return 'absent';
  return parseConsentRecord(row.record_json) ?? 'malformed';
}

export async function recordConsent(ws: WorkspaceContext, input: Rpc.ConsentInput): Promise<Port.RecordConsentOutcome> {
  try {
    if (!isValidConsentInput(input)) return { status: 'conflict' };
    const sessionDigest = await sha256Hex(input.participantSessionId);
    return ws.storage.transactionSync((): Port.RecordConsentOutcome => {
      const checked = gate(ws, 'participant-session');
      if (!checked.ok) return { status: 'held', reason: checked.reason };
      const existing = readConsent(ws, sessionDigest, input.now);
      if (existing === 'malformed') {
        logCorruptRecord('recordConsent');
        return { status: 'conflict' };
      }
      // First writer wins: a replay returns the stored record unchanged and
      // never renews its acceptance time or its absolute expiry.
      if (existing !== 'absent') {
        return consentMatches(existing, input) ? { status: 'accepted', consent: existing } : { status: 'conflict' };
      }
      // The store also refuses consent to a study revision that no longer exists.
      const row = readStudyRow(ws, input.studyId);
      const study = row ? decodeStudyRow(row) : null;
      if (!study || study.revision !== input.studyRevision) return { status: 'conflict' };
      const consent: ParticipantConsentRecord = {
        version: 1,
        participantSessionId: input.participantSessionId,
        studyId: input.studyId,
        studyRevision: input.studyRevision,
        consentHash: input.consentHash,
        acceptedAt: input.now,
      };
      ws.sql.exec(
        `INSERT INTO consents (session_digest, study_id, record_json, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (session_digest) DO UPDATE SET
           study_id = excluded.study_id, record_json = excluded.record_json, expires_at = excluded.expires_at`,
        sessionDigest,
        input.studyId,
        JSON.stringify(consent),
        input.now + CONSENT_TTL_MS,
      );
      return { status: 'accepted', consent };
    });
  } catch (error) {
    logStorageFailure('recordConsent', error);
    return { status: 'unavailable' };
  }
}

export async function verifyConsent(ws: WorkspaceContext, input: Rpc.ConsentInput): Promise<Port.VerifyConsentOutcome> {
  try {
    if (!isValidConsentInput(input)) return { status: 'mismatch' };
    const sessionDigest = await sha256Hex(input.participantSessionId);
    return ws.storage.transactionSync((): Port.VerifyConsentOutcome => {
      if (!gate(ws, 'read').ok) return { status: 'unavailable' };
      const existing = readConsent(ws, sessionDigest, input.now);
      if (existing === 'malformed') logCorruptRecord('verifyConsent');
      if (existing === 'absent' || existing === 'malformed') return { status: 'missing' };
      return consentMatches(existing, input) ? { status: 'accepted', consent: existing } : { status: 'mismatch' };
    });
  } catch (error) {
    logStorageFailure('verifyConsent', error);
    return { status: 'unavailable' };
  }
}

// ---------- Greeting/interview admission (first-consumption windows) ----------

function isValidCounter(counter: unknown): counter is { key: string; maximum: number; windowSeconds: number } {
  return isPlainObject(counter)
    && isHex64(counter.key)
    && typeof counter.maximum === 'number'
    && Number.isSafeInteger(counter.maximum)
    && counter.maximum >= 0
    && typeof counter.windowSeconds === 'number'
    && Number.isSafeInteger(counter.windowSeconds)
    && counter.windowSeconds > 0
    && counter.windowSeconds <= MAX_WINDOW_SECONDS;
}

type WindowRow = { count: number; expires_at: number };

/**
 * Check every counter, then charge every counter, in one synchronous
 * transaction. `rejectedIndex` is 0-based in counter order; a denial mutates
 * no scope. A window opens at its first charge and never slides.
 */
export async function admitParticipantRequest(ws: WorkspaceContext, input: Port.AdmissionInput): Promise<Port.AdmissionOutcome> {
  try {
    if (
      (input?.operation !== 'greeting' && input?.operation !== 'interview')
      || !Array.isArray(input.counters)
      || input.counters.length === 0
      || input.counters.length > MAX_ADMISSION_COUNTERS
      || !input.counters.every(isValidCounter)
      || !isSafeTime(input.now)
    ) {
      return { status: 'unavailable' };
    }
    const { counters, now } = input;
    return ws.storage.transactionSync((): Port.AdmissionOutcome => {
      const checked = gate(ws, 'participant-session');
      if (!checked.ok) return { status: 'held', reason: checked.reason };
      for (let index = 0; index < counters.length; index += 1) {
        const counter = counters[index];
        const row = ws.sql
          .exec<WindowRow>(`SELECT count, expires_at FROM budget_windows WHERE scope_key = ?`, counter.key)
          .toArray()[0];
        const active = row && row.expires_at > now ? row : null;
        if (active && (!Number.isSafeInteger(active.count) || active.count < 0 || !isSafeTime(active.expires_at))) {
          logCorruptRecord('admitParticipantRequest');
          return { status: 'unavailable' };
        }
        const count = active ? active.count : 0;
        if (count >= counter.maximum) {
          const retryAfterSeconds = active
            ? Math.max(1, Math.ceil((active.expires_at - now) / 1000))
            : Math.max(1, counter.windowSeconds);
          return { status: 'limited', rejectedIndex: index, retryAfterSeconds };
        }
      }
      for (let index = 0; index < counters.length; index += 1) {
        const counter = counters[index];
        // Re-read: the same scope may appear twice in one request.
        const row = ws.sql
          .exec<WindowRow>(`SELECT count, expires_at FROM budget_windows WHERE scope_key = ?`, counter.key)
          .toArray()[0];
        if (row && row.expires_at > now) {
          ws.sql.exec(`UPDATE budget_windows SET count = count + 1 WHERE scope_key = ?`, counter.key);
        } else {
          ws.sql.exec(
            `INSERT INTO budget_windows (scope_key, count, window_seconds, expires_at) VALUES (?, 1, ?, ?)
             ON CONFLICT (scope_key) DO UPDATE SET
               count = 1, window_seconds = excluded.window_seconds, expires_at = excluded.expires_at`,
            counter.key,
            counter.windowSeconds,
            now + counter.windowSeconds * 1000,
          );
        }
      }
      return { status: 'admitted' };
    });
  } catch (error) {
    logStorageFailure('admitParticipantRequest', error);
    return { status: 'unavailable' };
  }
}
