import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnalysisStatusPoller,
  nextPollDelayMs,
  POLL_READ_TIMEOUT_MS,
  waitForAnalysisOutcome,
  type PollerSnapshot,
} from '@/components/analysis/statusPoller';
import { AnalysisActionKeys } from '@/components/analysis/actionKeys';
import type { AnalysisRequestFailure, AnalysisStatusResult } from '@/services/analysisApi';
import type { AnalysisStatusBody } from '@/lib/storage/analysisProtocol';
import type { ConfirmedAnalysis } from '@/lib/analysisState';

const queued3: ConfirmedAnalysis = { status: 'pending', generation: 3, phase: 'queued' };

function ok(outcome: AnalysisStatusBody): AnalysisStatusResult {
  return { ok: true, outcome };
}

const pending3 = ok({ status: 'pending', generation: 3, phase: 'running', pollAfterMs: 2000 });
const unavailable: AnalysisRequestFailure = {
  ok: false, kind: 'unavailable', uncertain: false, error: 'The analysis status is temporarily unavailable. Try again shortly.',
};

let visibility: DocumentVisibilityState = 'visible';
const livePollers: AnalysisStatusPoller[] = [];
let online = true;

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

function setOnline(next: boolean) {
  online = next;
  window.dispatchEvent(new Event(next ? 'online' : 'offline'));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  online = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
});

afterEach(() => {
  livePollers.splice(0).forEach((poller) => poller.dispose());
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
  delete (navigator as unknown as Record<string, unknown>).onLine;
});

function makePoller(read: (signal: AbortSignal) => Promise<AnalysisStatusResult>, initial: ConfirmedAnalysis | null = queued3) {
  const snapshots: PollerSnapshot[] = [];
  const poller = new AnalysisStatusPoller({ read, initial, onChange: (snapshot) => snapshots.push(snapshot) });
  livePollers.push(poller);
  return { poller, snapshots, last: () => snapshots[snapshots.length - 1] ?? poller.snapshot() };
}

describe('polling schedule (API-03)', () => {
  it('API-03: 2 s through the first 30 s, then 5 s', () => {
    expect(nextPollDelayMs(0)).toBe(2_000);
    expect(nextPollDelayMs(29_999)).toBe(2_000);
    expect(nextPollDelayMs(30_000)).toBe(5_000);
    expect(nextPollDelayMs(170_000)).toBe(5_000);
  });

  it('API-03: a suggested interval is clamped to 2–10 s and never polls faster than the schedule', () => {
    expect(nextPollDelayMs(0, 2_000)).toBe(2_000);
    expect(nextPollDelayMs(0, 500)).toBe(2_000);
    expect(nextPollDelayMs(0, 8_000)).toBe(8_000);
    expect(nextPollDelayMs(0, 60_000)).toBe(10_000);
    expect(nextPollDelayMs(40_000, 2_000)).toBe(5_000);
    expect(nextPollDelayMs(0, Number.NaN)).toBe(2_000);
  });
});

describe('AnalysisStatusPoller (API-03)', () => {
  it('API-03: reads serially on schedule through the 180 s budget, then stops with work still pending', async () => {
    const read = vi.fn(async () => pending3);
    const { poller, last } = makePoller(read);
    poller.start();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(28_000);
    expect(read).toHaveBeenCalledTimes(15); // 2, 4, … 30 s
    await vi.advanceTimersByTimeAsync(150_000);
    expect(read).toHaveBeenCalledTimes(45); // then 35, 40, … 180 s
    expect(last()).toMatchObject({ phase: 'exhausted', budgetEnded: true, status: { status: 'pending', generation: 3 } });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(read).toHaveBeenCalledTimes(45);
    poller.dispose();
  });

  it('API-03: never overlaps reads while one is outstanding', async () => {
    let answer!: (result: AnalysisStatusResult) => void;
    const read = vi.fn(() => new Promise<AnalysisStatusResult>((resolve) => { answer = resolve; }));
    const { poller } = makePoller(read);
    poller.start();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(1);
    poller.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    answer(pending3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('API-03: a persisted outcome ends polling', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(pending3)
      .mockResolvedValueOnce(ok({ status: 'complete', generation: 3 }));
    const { poller, last } = makePoller(read);
    poller.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(last()).toMatchObject({ phase: 'settled', status: { status: 'complete', generation: 3 } });
    poller.dispose();
  });

  it('API-03: rejects a response older than the displayed generation and keeps polling', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(ok({ status: 'complete', generation: 2 }))
      .mockResolvedValue(pending3);
    const { poller, last } = makePoller(read);
    poller.start();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(last().status).toEqual(queued3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('API-03: adopts a newer generation and never regresses its outcome to pending', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(ok({ status: 'pending', generation: 4, phase: 'running' }))
      .mockResolvedValueOnce(ok({ status: 'failed', generation: 4, failureKind: 'timeout', recoveryRequired: true }));
    const { poller, last } = makePoller(read);
    poller.start();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(last().status).toEqual({ status: 'pending', generation: 4, phase: 'running' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(last().status).toEqual({ status: 'failed', generation: 4, failureKind: 'timeout', recoveryRequired: true });

    poller.seed({ status: 'pending', generation: 4, phase: 'running' });
    expect(poller.snapshot().status).toEqual({ status: 'failed', generation: 4, failureKind: 'timeout', recoveryRequired: true });
    poller.dispose();
  });

  it('API-03: honours a clamped server suggestion', async () => {
    const read = vi.fn(async () => ok({ status: 'pending', generation: 3, phase: 'queued', pollAfterMs: 60_000 }));
    const { poller } = makePoller(read);
    poller.seed(queued3, 60_000);
    poller.start();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('API-03: pauses while hidden and reads once on return, within the remaining budget', async () => {
    const read = vi.fn(async () => pending3);
    const { poller, last } = makePoller(read);
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    expect(last().phase).toBe('paused');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it('API-03: pauses while offline and reads once when back online', async () => {
    const read = vi.fn(async () => pending3);
    const { poller, last } = makePoller(read);
    poller.start();

    setOnline(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).not.toHaveBeenCalled();
    expect(last().phase).toBe('paused');

    setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it('API-03: a budget that ran out while hidden allows one read on return, then no more', async () => {
    const read = vi.fn(async () => pending3);
    const { poller, last } = makePoller(read);
    poller.start();

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(200_000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(last()).toMatchObject({ phase: 'exhausted', budgetEnded: true });
    poller.dispose();
  });

  it('API-03: a failed read halts polling, keeps the last confirmed state, and a refresh resumes it', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValue(pending3);
    const { poller, last } = makePoller(read);
    poller.start();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(last()).toMatchObject({ phase: 'halted', error: unavailable, status: queued3 });

    poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ error: null, status: { status: 'pending', generation: 3, phase: 'running' } });
    // Resumed within the same session: still inside its first 30 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it('API-03: dispose aborts the outstanding read and drops its late answer', async () => {
    let answer!: (result: AnalysisStatusResult) => void;
    let seenSignal: AbortSignal | undefined;
    const read = vi.fn((signal: AbortSignal) => {
      seenSignal = signal;
      return new Promise<AnalysisStatusResult>((resolve) => { answer = resolve; });
    });
    const { poller, snapshots } = makePoller(read);
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    const emitted = snapshots.length;

    poller.dispose();
    expect(seenSignal?.aborted).toBe(true);
    answer(ok({ status: 'complete', generation: 3 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshots).toHaveLength(emitted);
    expect(read).toHaveBeenCalledTimes(1);
  });

  function stalledReads() {
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<AnalysisStatusResult>(() => {});
    });
    return { read, signals };
  }

  it('API-03: the deadline aborts a read that never answers, ends the budget, and a refresh reads again', async () => {
    const { read, signals } = stalledReads();
    const { poller, last } = makePoller(read);
    poller.start();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(last().phase).toBe('reading');
    await vi.advanceTimersByTimeAsync(177_999);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    expect(last()).toMatchObject({ phase: 'exhausted', budgetEnded: true, error: null, status: queued3 });

    read.mockResolvedValueOnce(pending3);
    poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(last()).toMatchObject({ phase: 'exhausted', budgetEnded: true, status: { status: 'pending', phase: 'running' } });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('API-03: a manual read after the budget that never answers is bounded, reports the failure, and can be retried', async () => {
    const read = vi.fn<(signal: AbortSignal) => Promise<AnalysisStatusResult>>(async () => pending3);
    const { poller, last } = makePoller(read);
    poller.start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(last()).toMatchObject({ phase: 'exhausted', budgetEnded: true });
    const reads = read.mock.calls.length;

    const stalled = stalledReads();
    read.mockImplementationOnce(stalled.read);
    poller.refresh();
    expect(last().phase).toBe('reading');
    await vi.advanceTimersByTimeAsync(POLL_READ_TIMEOUT_MS);
    expect(stalled.signals[0].aborted).toBe(true);
    expect(last()).toMatchObject({ phase: 'halted', budgetEnded: true, error: { kind: 'network' } });

    poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(reads + 2);
    expect(last()).toMatchObject({ phase: 'exhausted', error: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('API-03: a read outstanding at the deadline while hidden pauses, and the return reads once', async () => {
    const { read, signals } = stalledReads();
    const { poller, last } = makePoller(read);
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    setVisibility('hidden');
    expect(last().phase).toBe('reading');

    await vi.advanceTimersByTimeAsync(178_000);
    expect(signals[0].aborted).toBe(true);
    expect(last()).toMatchObject({ phase: 'paused', budgetEnded: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);

    read.mockResolvedValueOnce(pending3);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(last()).toMatchObject({ phase: 'exhausted', budgetEnded: true });
  });

  it('API-03: dispose and a new session clear the outstanding read bound', async () => {
    const { read, signals } = stalledReads();
    const { poller } = makePoller(read);
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    poller.start();
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(2);

    poller.dispose();
    expect(signals[1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  function answersAfter(ms: number, result: () => AnalysisStatusResult) {
    return vi.fn(() => new Promise<AnalysisStatusResult>((resolve) => {
      setTimeout(() => resolve(result()), ms);
    }));
  }

  it('API-03: a read started just before the deadline still gets its answer', async () => {
    // A 2.5 s budget: the first read starts at 2 s with 0.5 s left and answers after 1.5 s.
    const read = answersAfter(1_500, () => ok({ status: 'complete', generation: 3 }));
    const snapshots: PollerSnapshot[] = [];
    const poller = new AnalysisStatusPoller({
      read, initial: queued3, budgetMs: 2_500, onChange: (snapshot) => snapshots.push(snapshot),
    });
    livePollers.push(poller);
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(snapshots[snapshots.length - 1]).toMatchObject({
      phase: 'settled', error: null, status: { status: 'complete', generation: 3 },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('API-03: a stalled read superseded by a stored outcome ends quietly and does not block a refresh', async () => {
    const { read, signals } = stalledReads();
    const { poller, last } = makePoller(read);
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(last().phase).toBe('reading');

    poller.seed({ status: 'complete', generation: 3 });
    expect(last()).toMatchObject({ phase: 'settled', error: null });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(signals[0].aborted).toBe(true);
    expect(last()).toMatchObject({ phase: 'settled', error: null, status: { status: 'complete', generation: 3 } });
    expect(vi.getTimerCount()).toBe(0);

    read.mockResolvedValueOnce(ok({ status: 'complete', generation: 3 }));
    poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(last()).toMatchObject({ phase: 'settled', error: null });
  });

  it('API-03: a check after a failed read near the deadline adopts its answer, and a stalled one reports its own failure', async () => {
    const read = vi.fn<(signal: AbortSignal) => Promise<AnalysisStatusResult>>().mockResolvedValueOnce(unavailable);
    const { poller, last } = makePoller(read);
    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(last()).toMatchObject({ phase: 'halted', error: unavailable, budgetEnded: false });

    await vi.advanceTimersByTimeAsync(177_500);
    read.mockImplementationOnce(answersAfter(2_000, () => pending3));
    poller.refresh();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(last()).toMatchObject({
      phase: 'exhausted', error: null, budgetEnded: true, status: { status: 'pending', phase: 'running' },
    });

    const stalled = stalledReads();
    const secondRead = vi.fn<(signal: AbortSignal) => Promise<AnalysisStatusResult>>()
      .mockResolvedValueOnce(unavailable)
      .mockImplementationOnce(stalled.read);
    const second = makePoller(secondRead);
    second.poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(second.last()).toMatchObject({ phase: 'halted', error: unavailable });
    await vi.advanceTimersByTimeAsync(177_500);
    second.poller.refresh();
    await vi.advanceTimersByTimeAsync(POLL_READ_TIMEOUT_MS - 1);
    expect(stalled.signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stalled.signals[0].aborted).toBe(true);
    expect(second.last()).toMatchObject({ phase: 'halted', error: { kind: 'network' }, budgetEnded: false });
  });

  it('API-03: removes its visibility and network listeners on dispose', async () => {
    const read = vi.fn(async () => pending3);
    const { poller } = makePoller(read);
    poller.start();
    setVisibility('hidden');
    poller.dispose();

    setVisibility('visible');
    setOnline(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('waitForAnalysisOutcome (API-04)', () => {
  it('API-04: resolves with the persisted outcome', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(pending3)
      .mockResolvedValueOnce(ok({ status: 'failed', generation: 3, failureKind: 'provider', recoveryRequired: false }));
    const outcome = waitForAnalysisOutcome({ read, initial: queued3, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(await outcome).toEqual({
      kind: 'settled',
      status: { status: 'failed', generation: 3, failureKind: 'provider', recoveryRequired: false },
    });
  });

  it('API-04: resolves as exhausted when the budget ends with work pending', async () => {
    const read = vi.fn(async () => pending3);
    const outcome = waitForAnalysisOutcome({ read, initial: queued3, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(180_000);

    expect(await outcome).toEqual({ kind: 'exhausted', status: { status: 'pending', generation: 3, phase: 'running' } });
  });

  it('API-04: a read that never answers resolves as exhausted at the deadline', async () => {
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<AnalysisStatusResult>(() => {});
    });
    let outcome: unknown;
    void waitForAnalysisOutcome({ read, initial: queued3, signal: new AbortController().signal })
      .then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(179_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toEqual({ kind: 'exhausted', status: queued3 });
    expect(signals[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('API-04: the last read, started just before the deadline, still settles the batch item', async () => {
    const read = vi.fn(() => new Promise<AnalysisStatusResult>((resolve) => {
      setTimeout(() => resolve(ok({ status: 'complete', generation: 3 })), 1_500);
    }));
    let outcome: unknown;
    void waitForAnalysisOutcome({ read, initial: queued3, signal: new AbortController().signal, budgetMs: 2_500 })
      .then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(3_500);

    expect(outcome).toEqual({ kind: 'settled', status: { status: 'complete', generation: 3 } });
  });

  it('API-04: resolves with the read failure', async () => {
    const outcome = waitForAnalysisOutcome({
      read: vi.fn().mockResolvedValue(unavailable), initial: queued3, signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await outcome).toEqual({ kind: 'error', failure: unavailable });
  });

  it('API-03: cancellation stops all further reads', async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => pending3);
    const outcome = waitForAnalysisOutcome({ read, initial: queued3, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();

    expect(await outcome).toEqual({ kind: 'cancelled' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('analysis action identity (API-03, UI-CF-03)', () => {
  const failure = (kind: AnalysisRequestFailure['kind'], uncertain: boolean): AnalysisRequestFailure => ({
    ok: false, kind, uncertain, error: 'x',
  });

  it('API-03: keeps the key and body across uncertain retries of one action', () => {
    const keys = new AnalysisActionKeys();
    const first = keys.actionFor('interview-1', 2);
    keys.settle('interview-1', failure('network', true));
    expect(keys.actionFor('interview-1', 2)).toEqual(first);
    keys.settle('interview-1', failure('unavailable', true));
    keys.settle('interview-1', failure('unconfirmed', true));
    expect(keys.actionFor('interview-1', 2)).toEqual(first);
  });

  it('API-03: a new intentional action after a confirmed answer gets a fresh key', () => {
    const keys = new AnalysisActionKeys();
    const first = keys.actionFor('interview-1', 2);
    keys.settle('interview-1', ok({ status: 'pending', generation: 3, phase: 'queued' }));
    const next = keys.actionFor('interview-1', 3);
    expect(next.key).not.toBe(first.key);
    expect(next.expectedGeneration).toBe(3);
  });

  it('API-03: a refreshed generation retires an unanswered action', () => {
    const keys = new AnalysisActionKeys();
    const first = keys.actionFor('interview-1', 2);
    expect(keys.actionFor('interview-1', 3).key).not.toBe(first.key);
  });

  it.each(['state-changed', 'key-conflict', 'not-found'] as const)(
    'API-01: %s retires the action; the next press is a new one',
    (kind) => {
      const keys = new AnalysisActionKeys();
      const first = keys.actionFor('interview-1', 2);
      keys.settle('interview-1', failure(kind, false));
      expect(keys.actionFor('interview-1', 2).key).not.toBe(first.key);
    },
  );

  it('API-03: keys are per interview and are v4 UUIDs', () => {
    const keys = new AnalysisActionKeys();
    const a = keys.actionFor('interview-1', 0);
    const b = keys.actionFor('interview-2', 0);
    expect(a.key).not.toBe(b.key);
    expect(a.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
