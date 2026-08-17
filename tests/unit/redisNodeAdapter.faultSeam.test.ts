// Node-redis adapter fault seam (Revision 12 §18). Seams are brand-gated;
// armed faults intercept by command name plus an optional eval script hint.
// 'drop' rejects before send (zero-write simulation), 'throw' rejects before
// send with a message, 'loss' sends and commits then rejects (may-have-
// committed simulation). Commands that pass the seam reach the real connect
// path; tests disable reconnection so a dead port rejects fast
// (ECONNREFUSED), proving pass-through without a live server. The full
// commit-then-loss behavior is exercised by the real-Redis integration
// suites (Phase 6), which run against the disposable container harness.

import { randomBytes } from 'node:crypto';
import type { RedisClientOptions } from 'redis';
import { describe, expect, it } from 'vitest';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import {
  RedisFaultDropError,
  RedisFaultResponseLossError,
  asRedisCount,
  createRedisNodeAdapter,
  injectNamedProductionFailpoint,
} from '@/lib/redisNodeAdapter';

const DEAD_URL = 'redis://127.0.0.1:6399';
const NO_RECONNECT: RedisClientOptions['socket'] = { reconnectStrategy: () => false };

function brandedAdapter() {
  return createRedisNodeAdapter({
    url: DEAD_URL,
    ownershipToken: randomBytes(32).toString('hex'),
    socket: NO_RECONNECT,
  });
}

/** The command passed the seam and reached the wire layer (dead port). */
async function expectPassesSeam(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: 'ECONNREFUSED' });
}

describe('redisNodeAdapter.faultSeam: effects', () => {
  it("'drop' rejects before send with the cut id (zero-write simulation)", async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'DROP-1', commands: 'ping', effect: 'drop' });
    const error: unknown = await adapter.ping().then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(RedisCommitAmbiguousError);
    expect((error as RedisCommitAmbiguousError).commitState).toBe('zero-write');
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(RedisFaultDropError);
    expect(((error as { cause?: RedisFaultDropError }).cause as RedisFaultDropError).cutId).toBe(
      'DROP-1'
    );
    await adapter.close();
  });

  it("'throw' rejects before send with the given message", async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'THROW-1', commands: 'eval', effect: 'throw', errorMessage: 'boom' });
    await expect(adapter.eval('-- script', ['k'], ['a'])).rejects.toThrow('boom');
    await adapter.close();
  });

  it("'throw' without a message names the cut id", async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'THROW-2', commands: 'eval', effect: 'throw' });
    await expect(adapter.eval('-- script', ['k'], ['a'])).rejects.toThrow(/THROW-2/);
    await adapter.close();
  });

  it("'loss' flows the command to the wire layer instead of rejecting pre-send", async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'LOSS-1', commands: 'ping', effect: 'loss' });
    // Dead port: the real connection error propagates (proving the seam did
    // not pre-send reject); the seam's own response-loss error is not thrown.
    await expectPassesSeam(adapter.ping());
    await adapter.close();
  });

  it('seam error classes carry name and cut id', () => {
    const drop = new RedisFaultDropError('D-1');
    expect(drop).toBeInstanceOf(Error);
    expect(drop.name).toBe('RedisFaultDropError');
    expect(drop.cutId).toBe('D-1');

    const loss = new RedisFaultResponseLossError('L-1');
    expect(loss).toBeInstanceOf(Error);
    expect(loss.name).toBe('RedisFaultResponseLossError');
    expect(loss.cutId).toBe('L-1');
  });
});

describe('redisNodeAdapter.faultSeam: arming and lifetime', () => {
  it('faults pre-armed at construction intercept the first matching command', async () => {
    const adapter = createRedisNodeAdapter({
      url: DEAD_URL,
      ownershipToken: randomBytes(32).toString('hex'),
      socket: NO_RECONNECT,
      faults: [{ cutId: 'INIT-1', commands: 'ping', effect: 'drop' }],
    });
    await expect(adapter.ping()).rejects.toBeInstanceOf(RedisCommitAmbiguousError);
    await adapter.close();
  });

  it("'once' faults are consumed after the first hit", async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'ONCE-1', commands: 'ping', effect: 'drop', once: true });
    await expect(adapter.ping()).rejects.toBeInstanceOf(RedisCommitAmbiguousError);
    await expectPassesSeam(adapter.ping());
    await adapter.close();
  });

  it("faults repeat while armed (once: false)", async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'REP-1', commands: 'ping', effect: 'drop', once: false });
    await expect(adapter.ping()).rejects.toBeInstanceOf(RedisCommitAmbiguousError);
    await expect(adapter.ping()).rejects.toBeInstanceOf(RedisCommitAmbiguousError);
    await adapter.close();
  });

  it('a fault only intercepts the named command', async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'EVAL-1', commands: 'eval', effect: 'drop' });
    await expectPassesSeam(adapter.ping());
    await expect(adapter.eval('-- script', ['k'], ['a'])).rejects.toBeInstanceOf(
      RedisCommitAmbiguousError
    );
    await adapter.close();
  });

  it('scriptHint targets only the matching eval script', async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'HINT-1', commands: 'eval', effect: 'drop', scriptHint: /begin-create/ });
    await expect(adapter.eval('-- begin-create study', ['k'], ['a'])).rejects.toBeInstanceOf(
      RedisCommitAmbiguousError
    );
    await expectPassesSeam(adapter.eval('-- publish other', ['k'], ['a']));
    await adapter.close();
  });

  it('scriptHint matches substrings as well as regular expressions', async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'HINT-2', commands: 'eval', effect: 'drop', scriptHint: 'begin-delete' });
    await expect(adapter.eval('-- begin-delete study', ['k'], ['a'])).rejects.toBeInstanceOf(
      RedisCommitAmbiguousError
    );
    await expectPassesSeam(adapter.eval('-- other', ['k'], ['a']));
    await adapter.close();
  });

  it('scriptHint does not suppress interception for non-eval commands', async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'HINT-3', commands: 'ping', effect: 'drop', scriptHint: 'irrelevant' });
    await expect(adapter.ping()).rejects.toBeInstanceOf(RedisCommitAmbiguousError);
    await adapter.close();
  });

  it('clearFaults disarms every armed fault', async () => {
    const adapter = brandedAdapter();
    adapter.armFault({ cutId: 'CLEAR-1', commands: 'ping', effect: 'drop' });
    adapter.armFault({ cutId: 'CLEAR-2', commands: 'eval', effect: 'drop' });
    adapter.clearFaults();
    await expectPassesSeam(adapter.ping());
    await expectPassesSeam(adapter.eval('-- script', ['k'], ['a']));
    await adapter.close();
  });

  it('armFault refuses on an unbranded adapter (production-like)', async () => {
    const adapter = createRedisNodeAdapter({ url: DEAD_URL, socket: NO_RECONNECT });
    expect(() =>
      adapter.armFault({ cutId: 'X-1', commands: 'ping', effect: 'drop' })
    ).toThrow(/ownership token/);
    await adapter.close();
  });
});

describe('redisNodeAdapter.faultSeam: named production failpoints', () => {
  it('injects a committing return after the last matching cut comment', () => {
    const script = [
      '-- fault cut adel-plan-ops',
      "redis.call('SET', KEYS[1], ARGV[1])",
      '-- fault cut adel-plan-ops',
      "redis.call('SET', KEYS[1], ARGV[2])",
    ].join('\n');
    const rewritten = injectNamedProductionFailpoint(script, 'adel-plan-ops');
    expect(rewritten).toContain("do return {'oi:failpoint'} end");
    expect(rewritten.indexOf('-- fault cut adel-plan-ops')).toBeLessThan(
      rewritten.lastIndexOf('-- fault cut adel-plan-ops')
    );
    expect(rewritten.indexOf("do return {'oi:failpoint'} end")).toBeGreaterThan(
      rewritten.lastIndexOf('-- fault cut adel-plan-ops')
    );
    expect(rewritten.indexOf("do return {'oi:failpoint'} end")).toBeLessThan(
      rewritten.indexOf("redis.call('SET', KEYS[1], ARGV[2])")
    );
  });

  it('matches W1 / S1 on the shared production comment', () => {
    const script = '-- fault cut W1 / S1: mapping reserved, study absent\nredis.call("SET", KEYS[1], ARGV[1])';
    expect(injectNamedProductionFailpoint(script, 'S1')).toContain("do return {'oi:failpoint'} end");
    expect(injectNamedProductionFailpoint(script, 'W1')).toContain("do return {'oi:failpoint'} end");
  });

  it('refuses an unknown cut id', () => {
    expect(() => injectNamedProductionFailpoint('-- no cuts', 'R1')).toThrow(/missing from script/);
  });

  it('coerces node-redis booleans onto the numeric RedisPort', () => {
    expect(asRedisCount(true)).toBe(1);
    expect(asRedisCount(false)).toBe(0);
    expect(asRedisCount(2)).toBe(2);
  });
});
