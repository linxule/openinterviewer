import type { AnalysisRequestFailure, AnalysisStatusResult } from '@/services/analysisApi';
import {
  adoptAnalysisStatus,
  confirmedAnalysisFromStatus,
  isActiveAnalysis,
  sameConfirmedAnalysis,
  type ConfirmedAnalysis,
} from '@/lib/analysisState';

// API-03 schedule: first read 2 s after acceptance, every 2 s through 30 s,
// then every 5 s through a 180 s wall-clock budget.
export const POLL_BUDGET_MS = 180_000;
export const POLL_FAST_WINDOW_MS = 30_000;
export const POLL_FAST_INTERVAL_MS = 2_000;
export const POLL_SLOW_INTERVAL_MS = 5_000;
export const POLL_SUGGESTION_MIN_MS = 2_000;
export const POLL_SUGGESTION_MAX_MS = 10_000;

export function clampSuggestedPollMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(POLL_SUGGESTION_MAX_MS, Math.max(POLL_SUGGESTION_MIN_MS, value));
}

/**
 * The client schedule is a floor: a server suggestion (clamped to 2–10 s) can
 * slow polling down but never speed it past the schedule.
 */
export function nextPollDelayMs(elapsedMs: number, suggestedMs?: number): number {
  const scheduled = elapsedMs < POLL_FAST_WINDOW_MS ? POLL_FAST_INTERVAL_MS : POLL_SLOW_INTERVAL_MS;
  const suggested = clampSuggestedPollMs(suggestedMs);
  return suggested === undefined ? scheduled : Math.max(scheduled, suggested);
}

/**
 * - idle: no polling session
 * - waiting / reading: a session is active
 * - paused: hidden or offline; one read follows the return
 * - exhausted: the budget ended with work still pending (reads on request only)
 * - halted: a read failed; the last confirmed state stands
 * - settled: nothing left to poll (persisted outcome or never scheduled)
 */
export type PollerPhase = 'idle' | 'waiting' | 'reading' | 'paused' | 'exhausted' | 'halted' | 'settled';

export type PollerSnapshot = {
  status: ConfirmedAnalysis | null;
  phase: PollerPhase;
  error: AnalysisRequestFailure | null;
  /** The session's budget has ended; stays true through later manual reads. */
  budgetEnded: boolean;
};

export type ReadAnalysisStatus = (signal: AbortSignal) => Promise<AnalysisStatusResult>;

export type AnalysisStatusPollerOptions = {
  read: ReadAnalysisStatus;
  onChange?: (snapshot: PollerSnapshot) => void;
  initial?: ConfirmedAnalysis | null;
  budgetMs?: number;
  now?: () => number;
};

function environmentSuspended(): boolean {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return hidden || offline;
}

const unexpectedReadFailure: AnalysisRequestFailure = {
  ok: false,
  kind: 'request',
  uncertain: false,
  error: 'The analysis status could not be checked. Try again.',
};

/**
 * Serial, bounded, read-only polling of one interview's analysis status.
 * It never starts work: the only request it makes is the status read.
 */
export class AnalysisStatusPoller {
  private status: ConfirmedAnalysis | null;
  private phase: PollerPhase = 'idle';
  private error: AnalysisRequestFailure | null = null;
  private budgetEnded = false;
  private sessionStart = 0;
  private deadline: number | null = null;
  private suggestion: number | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  private disposed = false;
  private emitted: PollerSnapshot | null = null;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private readonly onEnvironmentChange = () => this.handleEnvironmentChange();

  constructor(private readonly options: AnalysisStatusPollerOptions) {
    this.status = options.initial ?? null;
    this.budgetMs = options.budgetMs ?? POLL_BUDGET_MS;
    this.now = options.now ?? Date.now;
    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', this.onEnvironmentChange);
      window.addEventListener('online', this.onEnvironmentChange);
      window.addEventListener('offline', this.onEnvironmentChange);
    }
  }

  snapshot(): PollerSnapshot {
    return { status: this.status, phase: this.phase, error: this.error, budgetEnded: this.budgetEnded };
  }

  get hasSession(): boolean {
    return this.deadline !== null;
  }

  /** Adopt a state confirmed elsewhere (stored record, start response). */
  seed(incoming: ConfirmedAnalysis, suggestedMs?: number): void {
    if (this.disposed) return;
    this.status = adoptAnalysisStatus(this.status, incoming);
    if (suggestedMs !== undefined) this.suggestion = suggestedMs;
    if (!isActiveAnalysis(this.status) && this.phase !== 'idle') {
      this.clearTimer();
      this.phase = 'settled';
    }
    this.emit();
  }

  /** Begin a fresh budget, e.g. after a 202 or on opening active work. */
  start(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.abortInFlight();
    this.sessionStart = this.now();
    this.deadline = this.sessionStart + this.budgetMs;
    this.error = null;
    this.budgetEnded = false;
    this.scheduleNext();
  }

  /**
   * One read now. Automatic polling resumes only when work is still pending
   * and the current session's budget remains.
   */
  refresh(): void {
    if (this.disposed || this.inFlight) return;
    this.clearTimer();
    void this.read();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.abortInFlight();
    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onEnvironmentChange);
      window.removeEventListener('online', this.onEnvironmentChange);
      window.removeEventListener('offline', this.onEnvironmentChange);
    }
  }

  private scheduleNext(): void {
    if (this.disposed) return;
    if (!isActiveAnalysis(this.status)) {
      this.phase = this.deadline === null ? 'idle' : 'settled';
      this.emit();
      return;
    }
    if (this.deadline === null) {
      // A read confirmed pending work outside any session: give it one.
      this.sessionStart = this.now();
      this.deadline = this.sessionStart + this.budgetMs;
    }
    if (environmentSuspended()) {
      this.phase = 'paused';
      this.emit();
      return;
    }
    const at = this.now();
    const delay = nextPollDelayMs(at - this.sessionStart, this.suggestion);
    if (at + delay > this.deadline) {
      this.phase = 'exhausted';
      this.budgetEnded = true;
      this.emit();
      return;
    }
    this.phase = 'waiting';
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.read();
    }, delay);
    this.emit();
  }

  private async read(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    const controller = new AbortController();
    this.inFlight = controller;
    this.phase = 'reading';
    this.emit();
    let result: AnalysisStatusResult;
    try {
      result = await this.options.read(controller.signal);
    } catch {
      result = unexpectedReadFailure;
    }
    // Superseded by dispose() or a new session: drop the answer.
    if (this.disposed || this.inFlight !== controller) return;
    this.inFlight = null;
    if (!result.ok && result.kind === 'network' && this.deadline !== null && environmentSuspended()) {
      // Lost to going hidden/offline mid-read: pause; the return reads again.
      this.phase = 'paused';
      this.emit();
      return;
    }
    if (!result.ok) {
      this.error = result;
      this.phase = 'halted';
      this.emit();
      return;
    }
    this.error = null;
    this.status = adoptAnalysisStatus(this.status, confirmedAnalysisFromStatus(result.outcome));
    this.suggestion = result.outcome.status === 'pending' ? result.outcome.pollAfterMs : undefined;
    this.scheduleNext();
  }

  private handleEnvironmentChange(): void {
    if (this.disposed) return;
    if (environmentSuspended()) {
      if (this.timer) {
        this.clearTimer();
        this.phase = 'paused';
        this.emit();
      }
      // A read in flight completes; its scheduling step sees the suspension.
      return;
    }
    if (this.phase === 'paused') void this.read();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private abortInFlight(): void {
    if (this.inFlight) {
      this.inFlight.abort();
      this.inFlight = null;
    }
  }

  private emit(): void {
    const next = this.snapshot();
    const previous = this.emitted;
    if (
      previous
      && previous.phase === next.phase
      && previous.error === next.error
      && previous.budgetEnded === next.budgetEnded
      && sameConfirmedAnalysis(previous.status, next.status)
    ) {
      return;
    }
    this.emitted = next;
    this.options.onChange?.(next);
  }
}

export type AnalysisWaitOutcome =
  | { kind: 'settled'; status: ConfirmedAnalysis }
  | { kind: 'exhausted'; status: ConfirmedAnalysis }
  | { kind: 'error'; failure: AnalysisRequestFailure }
  | { kind: 'cancelled' };

/** Poll one accepted job until it settles, the budget ends, a read fails or the caller aborts. */
export function waitForAnalysisOutcome(options: {
  read: ReadAnalysisStatus;
  initial: ConfirmedAnalysis;
  signal: AbortSignal;
  budgetMs?: number;
  now?: () => number;
}): Promise<AnalysisWaitOutcome> {
  return new Promise((resolve) => {
    let done = false;
    let poller: AnalysisStatusPoller | null = null;
    const finish = (outcome: AnalysisWaitOutcome) => {
      if (done) return;
      done = true;
      poller?.dispose();
      options.signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: 'cancelled' });
    if (options.signal.aborted) {
      finish({ kind: 'cancelled' });
      return;
    }
    options.signal.addEventListener('abort', onAbort);
    poller = new AnalysisStatusPoller({
      read: options.read,
      initial: options.initial,
      budgetMs: options.budgetMs,
      now: options.now,
      onChange: (snapshot) => {
        if (snapshot.status && !isActiveAnalysis(snapshot.status)) {
          finish({ kind: 'settled', status: snapshot.status });
        } else if (snapshot.phase === 'exhausted' && snapshot.status) {
          finish({ kind: 'exhausted', status: snapshot.status });
        } else if (snapshot.phase === 'halted' && snapshot.error) {
          finish({ kind: 'error', failure: snapshot.error });
        }
      },
    });
    poller.start();
  });
}
