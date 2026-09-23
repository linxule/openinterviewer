// Researcher sign-in attempt budget (gap F5; Cloudflare target only).
//
// Two fixed windows, each opened by its first counted attempt and never
// extended by later ones: per client (a salted HMAC of the admission identity,
// computed by the durable client so no address reaches storage) and one
// global window.
//
// Admission is atomic: admitLoginAttempt refuses when either window is at its
// limit and otherwise counts the attempt in both, in one transaction, before
// the route compares the password. Concurrent requests therefore cannot pass
// a check that none of them has yet counted: at most the limit reach the
// comparison per window. A wrong password leaves its attempt counted; a
// correct one calls refundLoginAttempt. A refund that never arrives leaves
// the attempt counted (fail closed), so the net count is the failures plus
// any attempt whose refund was lost.
//
// These methods run in every maintenance state and under epoch or identity
// holds: operators must be able to sign in to a frozen or recovering
// workspace. The table is per-object operational state: it is not part of an
// operational backup and never advances the research mutation sequence, so a
// held workspace's backup watermark is unaffected by sign-in attempts.

import {
  LOGIN_CLIENT_MAX_FAILURES,
  LOGIN_CLIENT_WINDOW_SECONDS,
  LOGIN_GLOBAL_MAX_FAILURES,
  LOGIN_GLOBAL_WINDOW_SECONDS,
} from '../../src/lib/storage/types';
import type * as Rpc from './rpcTypes';
import type { WorkspaceContext } from './context';
import { isHex64, isSafeTime, logCorruptRecord, logStorageFailure } from './studies';

/** The one global scope row; client keys are 64-hex digests and cannot collide with it. */
export const LOGIN_GLOBAL_SCOPE = 'global';
/** Expired rows removed per admitted attempt, which keeps the table bounded. */
export const LOGIN_CLEANUP_BATCH = 100;

type Scope = { key: string; maximum: number; windowMs: number; name: 'client' | 'global' };

type WindowRow = { attempts: number; expires_at: number };

function scopes(clientKey: string): Scope[] {
  return [
    { key: LOGIN_GLOBAL_SCOPE, maximum: LOGIN_GLOBAL_MAX_FAILURES, windowMs: LOGIN_GLOBAL_WINDOW_SECONDS * 1000, name: 'global' },
    { key: clientKey, maximum: LOGIN_CLIENT_MAX_FAILURES, windowMs: LOGIN_CLIENT_WINDOW_SECONDS * 1000, name: 'client' },
  ];
}

function validInput(input: Rpc.LoginAttemptInput | undefined): input is Rpc.LoginAttemptInput {
  return !!input && isHex64(input.clientKey) && isSafeTime(input.now);
}

class CorruptWindowError extends Error {}

/** The scope's window while it is open, or null once it has expired. */
function openWindow(sql: SqlStorage, key: string, now: number): WindowRow | null {
  const row = sql
    .exec<WindowRow>(`SELECT attempts, expires_at FROM login_attempts WHERE scope_key = ?`, key)
    .toArray()[0];
  if (!row) return null;
  if (!Number.isSafeInteger(row.attempts) || row.attempts < 0 || !isSafeTime(row.expires_at)) {
    throw new CorruptWindowError();
  }
  return row.expires_at > now ? row : null;
}

function logFailure(operation: string, error: unknown): void {
  if (error instanceof CorruptWindowError) logCorruptRecord(operation);
  else logStorageFailure(operation, error);
}

export function admitLoginAttempt(ws: WorkspaceContext, input: Rpc.LoginAttemptInput): Rpc.LoginAdmitOutcome {
  if (!validInput(input)) return { status: 'unavailable' };
  const now = input.now;
  try {
    return ws.storage.transactionSync((): Rpc.LoginAdmitOutcome => {
      const windows = scopes(input.clientKey).map((scope) => ({ scope, open: openWindow(ws.sql, scope.key, now) }));
      // When both are exhausted, report the later end: the earlier one would only refuse again.
      let limited: { scope: Scope['name']; retryAfterSeconds: number } | null = null;
      for (const { scope, open } of windows) {
        if (!open || open.attempts < scope.maximum) continue;
        const retryAfterSeconds = Math.max(1, Math.ceil((open.expires_at - now) / 1000));
        if (!limited || retryAfterSeconds > limited.retryAfterSeconds) limited = { scope: scope.name, retryAfterSeconds };
      }
      if (limited) return { status: 'limited', ...limited };

      for (const { scope, open } of windows) {
        if (open) {
          ws.sql.exec(`UPDATE login_attempts SET attempts = attempts + 1 WHERE scope_key = ?`, scope.key);
        } else {
          ws.sql.exec(
            `INSERT INTO login_attempts (scope_key, attempts, expires_at) VALUES (?, 1, ?)
             ON CONFLICT (scope_key) DO UPDATE SET attempts = 1, expires_at = excluded.expires_at`,
            scope.key,
            now + scope.windowMs,
          );
        }
      }
      ws.sql.exec(
        `DELETE FROM login_attempts WHERE scope_key IN (
           SELECT scope_key FROM login_attempts WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
        now,
        LOGIN_CLEANUP_BATCH,
      );
      return { status: 'admitted' };
    });
  } catch (error) {
    // The transaction rolled back: nothing was counted, and the route refuses.
    logFailure('admitLoginAttempt', error);
    return { status: 'unavailable' };
  }
}

/**
 * Returns one admitted attempt after a correct password. A window that has
 * ended meanwhile has nothing to return; a window left at zero is removed, so
 * the next failure opens a fresh one as if the success had never counted.
 */
export function refundLoginAttempt(ws: WorkspaceContext, input: Rpc.LoginAttemptInput): Rpc.LoginRefundOutcome {
  if (!validInput(input)) return { status: 'unavailable' };
  const now = input.now;
  try {
    return ws.storage.transactionSync((): Rpc.LoginRefundOutcome => {
      for (const scope of scopes(input.clientKey)) {
        const open = openWindow(ws.sql, scope.key, now);
        if (!open || open.attempts === 0) continue;
        if (open.attempts === 1) {
          ws.sql.exec(`DELETE FROM login_attempts WHERE scope_key = ?`, scope.key);
        } else {
          ws.sql.exec(`UPDATE login_attempts SET attempts = attempts - 1 WHERE scope_key = ?`, scope.key);
        }
      }
      return { status: 'refunded' };
    });
  } catch (error) {
    logFailure('refundLoginAttempt', error);
    return { status: 'unavailable' };
  }
}
