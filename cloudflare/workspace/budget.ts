// First-consumption budget windows (budget_windows) shared by participant
// greeting/interview admission and the researcher AI budget (D15). Keys are
// hex64 digests the durable client salts and digests; researcher and
// participant keys are digested from disjoint prefixes (`researcher-ai:` and
// `rate-limit:`), so the two budgets never share a row.

import type * as Port from '../../src/lib/storage/types';
import { gate, type WorkspaceContext } from './context';
import { isHex64, isPlainObject, isSafeTime, logCorruptRecord, logStorageFailure } from './studies';

export const MAX_ADMISSION_COUNTERS = 8;
const MAX_WINDOW_SECONDS = 31 * 24 * 60 * 60;

const RESEARCHER_AI_OPERATIONS: ReadonlySet<Port.ResearcherAiOperation> = new Set([
  'greeting',
  'interview',
  'synthesis',
  'aggregate',
  'followup',
  'analysis',
]);

export type BudgetCounter = { key: string; maximum: number; windowSeconds: number };

function isValidCounter(counter: unknown): counter is BudgetCounter {
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

export function isValidCounterList(counters: unknown): counters is BudgetCounter[] {
  return Array.isArray(counters)
    && counters.length > 0
    && counters.length <= MAX_ADMISSION_COUNTERS
    && counters.every(isValidCounter);
}

type WindowRow = { count: number; expires_at: number };

export type WindowCharge =
  | { status: 'admitted' }
  | { status: 'limited'; rejectedIndex: number; retryAfterSeconds: number }
  | { status: 'corrupt' };

/**
 * Check every counter, then charge every counter. Runs inside the caller's
 * storage transaction; `rejectedIndex` is 0-based in counter order and a
 * denial mutates no scope. A window opens at its first charge and never
 * slides.
 */
export function chargeBudgetWindows(ws: WorkspaceContext, counters: BudgetCounter[], now: number): WindowCharge {
  for (let index = 0; index < counters.length; index += 1) {
    const counter = counters[index];
    const row = ws.sql
      .exec<WindowRow>(`SELECT count, expires_at FROM budget_windows WHERE scope_key = ?`, counter.key)
      .toArray()[0];
    const active = row && row.expires_at > now ? row : null;
    if (active && (!Number.isSafeInteger(active.count) || active.count < 0 || !isSafeTime(active.expires_at))) {
      return { status: 'corrupt' };
    }
    const count = active ? active.count : 0;
    if (count >= counter.maximum) {
      const retryAfterSeconds = active
        ? Math.max(1, Math.ceil((active.expires_at - now) / 1000))
        : Math.max(1, counter.windowSeconds);
      return { status: 'limited', rejectedIndex: index, retryAfterSeconds };
    }
  }
  for (const counter of counters) {
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
}

/**
 * Researcher AI admission (D15) before a researcher-initiated provider call:
 * preview greeting/interview/synthesis, aggregate synthesis and follow-up
 * generation. Queued analysis charges its counters inside acceptAnalysisRetry
 * instead, so only a newly allocated generation pays. The `researcher-ai`
 * gate admits while open or draining, the states in which a paid researcher
 * call may run (F26); routes whose call ends in a researcher mutation refuse
 * draining themselves before reaching here.
 */
export async function admitResearcherAiRequest(
  ws: WorkspaceContext,
  input: Port.ResearcherAiAdmissionInput,
): Promise<Port.AdmissionOutcome> {
  try {
    if (
      !isPlainObject(input)
      || !RESEARCHER_AI_OPERATIONS.has(input.operation)
      || !isValidCounterList(input.counters)
      || !isSafeTime(input.now)
    ) {
      return { status: 'unavailable' };
    }
    const { counters, now } = input;
    return ws.storage.transactionSync((): Port.AdmissionOutcome => {
      const checked = gate(ws, 'researcher-ai');
      if (!checked.ok) return { status: 'held', reason: checked.reason };
      const charged = chargeBudgetWindows(ws, counters, now);
      if (charged.status === 'corrupt') {
        logCorruptRecord('admitResearcherAiRequest');
        return { status: 'unavailable' };
      }
      return charged;
    });
  } catch (error) {
    logStorageFailure('admitResearcherAiRequest', error);
    return { status: 'unavailable' };
  }
}
