// VERIFY-01 restart lane: SIGKILL inside an uncommitted storage transaction.
// This is the M0 crash probe's `inside-tx` cut (evidence/M0-feasibility.md),
// made repeatable. No production WorkspaceStore transaction can be held open
// from outside, so the cut runs on a probe object (txProbe.worker.js) that
// uses the same `ctx.storage.transaction(async () => { SQL; await setAlarm() })`
// shape the production object relies on for every job-and-alarm change.
import { afterAll, describe, expect, it } from 'vitest';
import { killRunner, makeStateDir, readEvents, removeStateDir, send, startRunner, type Runner } from './lane';

const live = new Set<Runner>();
const dir = makeStateDir('txprobe');

afterAll(async () => {
  for (const runner of live) await killRunner(runner).catch(() => undefined);
  removeStateDir(dir);
});

type Snapshot = { rows: string[]; alarm: number | null };

async function snapshot(base: string): Promise<Snapshot> {
  const response = await send(base, '/snapshot');
  expect(response.status).toBe(200);
  return await response.json() as Snapshot;
}

describe('VERIFY-01 SIGKILL inside an open storage transaction (M0 inside-tx, JOB-05)', () => {
  it('VERIFY-01/JOB-05 SIGKILL while a transaction holding SQL and an earlier alarm is still open leaves neither after restart; the committed row and its own alarm survive and fire unprompted', async () => {
    const first = await startRunner(dir, 'r1', { worker: 'txprobe' });
    live.add(first);
    const committed = await send(first.workerUrl, '/commit?id=committed&due=6000');
    expect(committed.status).toBe(200);
    const afterCommit = await committed.json() as Snapshot;
    expect(afterCommit.rows).toEqual(['committed']);
    const committedAlarm = afterCommit.alarm!;
    expect(committedAlarm).not.toBeNull();

    // SQL plus an alarm due before the committed one, then the transaction waits on the runner.
    const open = send(first.workerUrl, '/hold-open?id=uncommitted&due=1000').then(
      (response) => ({ status: response.status }),
      (error: unknown) => ({ lost: error instanceof Error ? error.name : 'unknown' }),
    );
    await first.held('probe-transaction', 30_000);
    await killRunner(first);
    live.delete(first);
    expect(await open).toHaveProperty('lost');

    const second = await startRunner(dir, 'r2', { worker: 'txprobe' });
    live.add(second);
    // No request until both deadlines have passed: the rolled-back earlier alarm
    // must not fire, and the committed one must fire by itself.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, committedAlarm - Date.now()) + 3_000));
    expect(readEvents(dir).filter((event) => event.kind === 'request' && event.runtime === 'r2')).toEqual([]);
    const state = await snapshot(second.workerUrl);
    expect(state.rows).not.toContain('uncommitted');
    expect(state.rows[0]).toBe('committed');
    expect(state.rows.filter((row) => row.startsWith('alarm-fired-'))).toHaveLength(1);
    const fired = Number(state.rows.find((row) => row.startsWith('alarm-fired-'))!.slice('alarm-fired-'.length));
    // It fired at the committed deadline, not at the rolled-back earlier one.
    expect(fired).toBeGreaterThanOrEqual(committedAlarm);
    expect(state.alarm).toBeNull();
    expect(readEvents(dir).filter((event) => event.kind === 'refused')).toEqual([]);
    await killRunner(second);
    live.delete(second);
  });
});
