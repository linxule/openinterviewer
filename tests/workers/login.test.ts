// Researcher sign-in attempt budget in the real WorkspaceStore (gap F5):
// per-client 10 attempts / 15 minutes and 200 / hour across all clients, both
// fixed windows opened by the first counted attempt. Admission counts the
// attempt atomically before the password is compared, so a concurrent burst
// cannot outrun the limit; a correct password refunds its attempt. Allowed in
// every maintenance state and hold; outside operational backups and the
// research mutation sequence. Also drives the durable client that digests
// identities.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reset } from 'cloudflare:test';
import { createHmac } from 'node:crypto';
import { BACKUP_FAMILY_NAMES } from '../../src/lib/backup/format';
import { createDurableLoginBudget, loginClientKey } from '../../src/lib/storage/durableObject';
import {
  LOGIN_CLIENT_MAX_FAILURES,
  LOGIN_CLIENT_WINDOW_SECONDS,
  LOGIN_GLOBAL_MAX_FAILURES,
  LOGIN_GLOBAL_WINDOW_SECONDS,
} from '../../src/lib/storage/types';
import type { AdmissionIdentity } from '../../src/lib/runtime/workerInvocation';
import { LOGIN_CLEANUP_BATCH } from '../../cloudflare/workspace/login';
import { captureStoreEvents, count, mutationSeq, randomHex64, setMaintenance, sql, T0 } from './fixtures';
import { testEnv, workspaceStub } from './helpers';

const MINUTE = 60 * 1000;
type BackupPage = { status: string; watermark?: { maintenanceVersion: number; mutationSeq: number } };
const SALT = testEnv.RATE_LIMIT_SALT as string;

beforeEach(async () => {
  await reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function admit(clientKey: string, now: number) {
  return workspaceStub().admitLoginAttempt({ clientKey, now });
}

function refund(clientKey: string, now: number) {
  return workspaceStub().refundLoginAttempt({ clientKey, now });
}

/** A failed sign-in is an admitted attempt that is never refunded. */
async function fail(clientKey: string, now: number, times = 1): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    expect(await admit(clientKey, now)).toEqual({ status: 'admitted' });
  }
}

async function attempts(scopeKey: string): Promise<number | null> {
  const rows = await sql<{ attempts: number }>(`SELECT attempts FROM login_attempts WHERE scope_key = ?`, scopeKey);
  return rows[0]?.attempts ?? null;
}

function budget() {
  return createDurableLoginBudget({
    namespace: testEnv.WORKSPACE_STORE,
    workspaceId: testEnv.WORKSPACE_ID,
    jurisdiction: '',
    rateLimitSalt: SALT,
  });
}

describe('F5 per-client sign-in budget', () => {
  it('F5 admits 10 attempts per client, then limits until the window opened by the first attempt ends', async () => {
    const client = randomHex64();
    await fail(client, T0, LOGIN_CLIENT_MAX_FAILURES - 1);
    await fail(client, T0 + 10 * MINUTE);
    expect(await admit(client, T0 + 10 * MINUTE)).toEqual({
      status: 'limited',
      scope: 'client',
      retryAfterSeconds: 5 * 60,
    });
    // A refusal counts nothing, and later attempts never extend the window:
    // it ends 15 minutes after the first.
    expect(await attempts(client)).toBe(LOGIN_CLIENT_MAX_FAILURES);
    const windowEnd = T0 + LOGIN_CLIENT_WINDOW_SECONDS * 1000;
    expect((await admit(client, windowEnd - 1_000)).status).toBe('limited');
    expect(await admit(client, windowEnd)).toEqual({ status: 'admitted' });
    // Another client is unaffected throughout.
    expect(await admit(randomHex64(), T0 + 10 * MINUTE)).toEqual({ status: 'admitted' });
  });

  it('F5 an attempt after the window ends opens a fresh window at one', async () => {
    const client = randomHex64();
    await fail(client, T0, LOGIN_CLIENT_MAX_FAILURES);
    const later = T0 + LOGIN_CLIENT_WINDOW_SECONDS * 1000 + MINUTE;
    await fail(client, later);
    const rows = await sql<{ attempts: number; expires_at: number }>(
      `SELECT attempts, expires_at FROM login_attempts WHERE scope_key = ?`,
      client,
    );
    expect(rows).toEqual([{ attempts: 1, expires_at: later + LOGIN_CLIENT_WINDOW_SECONDS * 1000 }]);
  });
});

describe('F5 admission is atomic under concurrency', () => {
  it('F5 a concurrent burst from one client reaches the password comparison at most 10 times', async () => {
    // The route's sequence: admit, then compare only when admitted.
    const client = budget();
    const identity: AdmissionIdentity = { kind: 'address', address: '203.0.113.7' };
    let compared = 0;
    const outcomes = await Promise.all(Array.from({ length: 100 }, async () => {
      const admission = await client.admitLoginAttempt({ identity, now: T0 });
      if (admission.status === 'admitted') compared += 1;
      return admission.status;
    }));
    expect(compared).toBe(LOGIN_CLIENT_MAX_FAILURES);
    expect(outcomes.filter((status) => status === 'limited')).toHaveLength(100 - LOGIN_CLIENT_MAX_FAILURES);
    expect(await attempts(await loginClientKey(SALT, identity))).toBe(LOGIN_CLIENT_MAX_FAILURES);
    expect(await attempts('global')).toBe(LOGIN_CLIENT_MAX_FAILURES);
  });

  it('F5 a burst from one address cannot exhaust the global budget and lock other clients out', async () => {
    const client = budget();
    const attacker: AdmissionIdentity = { kind: 'address', address: '203.0.113.7' };
    await Promise.all(Array.from({ length: LOGIN_GLOBAL_MAX_FAILURES }, () => client.admitLoginAttempt({ identity: attacker, now: T0 })));
    expect(await attempts('global')).toBe(LOGIN_CLIENT_MAX_FAILURES);
    expect(await client.admitLoginAttempt({ identity: { kind: 'address', address: '198.51.100.44' }, now: T0 }))
      .toEqual({ status: 'admitted' });
  });
});

describe('F5 a correct password refunds its attempt', () => {
  it('F5 only failures stay counted: a refunded success leaves room for the tenth failure', async () => {
    const client = randomHex64();
    await fail(client, T0, LOGIN_CLIENT_MAX_FAILURES - 1);
    expect(await admit(client, T0 + MINUTE)).toEqual({ status: 'admitted' });
    expect(await refund(client, T0 + MINUTE)).toEqual({ status: 'refunded' });
    expect(await attempts(client)).toBe(LOGIN_CLIENT_MAX_FAILURES - 1);
    await fail(client, T0 + 2 * MINUTE);
    expect((await admit(client, T0 + 2 * MINUTE)).status).toBe('limited');
  });

  it('F5 a window left at zero is removed, so the next failure opens a fresh one', async () => {
    const client = randomHex64();
    expect(await admit(client, T0)).toEqual({ status: 'admitted' });
    expect(await refund(client, T0 + MINUTE)).toEqual({ status: 'refunded' });
    expect(await count('login_attempts')).toBe(0);
    await fail(client, T0 + 5 * MINUTE);
    const rows = await sql<{ expires_at: number }>(`SELECT expires_at FROM login_attempts WHERE scope_key = ?`, client);
    expect(rows).toEqual([{ expires_at: T0 + 5 * MINUTE + LOGIN_CLIENT_WINDOW_SECONDS * 1000 }]);
  });

  it('F5 a refund after both windows ended changes nothing', async () => {
    const client = randomHex64();
    await fail(client, T0);
    expect(await refund(client, T0 + LOGIN_GLOBAL_WINDOW_SECONDS * 1000)).toEqual({ status: 'refunded' });
    expect(await attempts(client)).toBe(1);
    expect(await attempts('global')).toBe(1);
  });
});

describe('F5 global sign-in budget', () => {
  it('F5 limits every client after 200 attempts across clients within one hour', async () => {
    // 25 clients × 8 attempts stay under each client budget but exhaust the global one.
    for (let index = 0; index < LOGIN_GLOBAL_MAX_FAILURES / 8; index += 1) {
      await fail(randomHex64(), T0 + index * MINUTE, 8);
    }
    const fresh = randomHex64();
    expect(await admit(fresh, T0 + 30 * MINUTE)).toEqual({
      status: 'limited',
      scope: 'global',
      retryAfterSeconds: 30 * 60,
    });
    expect(await admit(fresh, T0 + LOGIN_GLOBAL_WINDOW_SECONDS * 1000)).toEqual({ status: 'admitted' });
  });

  it('F5 when both windows are exhausted the later end is reported', async () => {
    for (let index = 0; index < 19; index += 1) await fail(randomHex64(), T0 + index * MINUTE, LOGIN_CLIENT_MAX_FAILURES);
    const client = randomHex64();
    await fail(client, T0 + 50 * MINUTE, LOGIN_CLIENT_MAX_FAILURES);
    // Global ends at T0+60min, this client's window at T0+65min.
    expect(await admit(client, T0 + 55 * MINUTE)).toEqual({ status: 'limited', scope: 'client', retryAfterSeconds: 10 * 60 });
    expect(await admit(randomHex64(), T0 + 55 * MINUTE)).toEqual({ status: 'limited', scope: 'global', retryAfterSeconds: 5 * 60 });
  });
});

describe('F5 sign-in is available whatever the workspace state', () => {
  it.each(['open', 'draining', 'frozen', 'recovery'] as const)('F5 admits and refunds attempts while %s', async (state) => {
    await setMaintenance(state);
    const client = randomHex64();
    await fail(client, T0);
    expect(await admit(client, T0)).toEqual({ status: 'admitted' });
    expect(await refund(client, T0)).toEqual({ status: 'refunded' });
  });

  it('F5 admits and refunds attempts under a recovery-epoch hold', async () => {
    await sql(`UPDATE workspace_meta SET activated_epoch = ?`, `ep_${'0'.repeat(31)}9`);
    expect((await workspaceStub().readiness()).status).toBe('held');
    const client = randomHex64();
    await fail(client, T0);
    expect(await refund(client, T0)).toEqual({ status: 'refunded' });
  });
});

describe('F5 sign-in attempts are operational state, not research data', () => {
  it('F5 failures never advance the research mutation sequence, so a held backup watermark holds', async () => {
    await setMaintenance('frozen');
    // The stub's RPC typing drops the `rows: unknown[]` variant; read it as the page it is.
    const first = await workspaceStub().exportBackupPage({ watermark: null, family: 'workspace_meta', cursor: null, pageSize: 10 }) as unknown as BackupPage;
    expect(first.status).toBe('ok');
    const before = await mutationSeq();
    await fail(randomHex64(), T0, 3);
    expect(await mutationSeq()).toBe(before);
    const watermark = first.watermark!;
    const again = await workspaceStub().exportBackupPage({ watermark, family: 'studies', cursor: null, pageSize: 10 });
    expect(again.status).toBe('ok');
  });

  it('F5 login_attempts is excluded from operational backups', async () => {
    await setMaintenance('frozen');
    expect(BACKUP_FAMILY_NAMES).not.toContain('login_attempts');
    expect(await workspaceStub().exportBackupPage({ watermark: null, family: 'login_attempts', cursor: null, pageSize: 10 }))
      .toEqual({ status: 'unavailable' });
  });

  it('F5 each admitted attempt removes a bounded batch of expired windows', async () => {
    for (let index = 0; index < LOGIN_CLEANUP_BATCH + 50; index += 1) {
      await sql(`INSERT INTO login_attempts (scope_key, attempts, expires_at) VALUES (?, 3, ?)`, randomHex64(), T0 - MINUTE - index);
    }
    await fail(randomHex64(), T0);
    expect(await count('login_attempts', 'expires_at <= ?', T0)).toBe(50);
    await fail(randomHex64(), T0);
    expect(await count('login_attempts', 'expires_at <= ?', T0)).toBe(0);
  });
});

describe('F5 input validation and corruption', () => {
  it.each([
    ['the reserved global scope', { clientKey: 'global', now: T0 }],
    ['a raw address', { clientKey: '203.0.113.7', now: T0 }],
    ['an uppercase digest', { clientKey: 'A'.repeat(64), now: T0 }],
    ['a negative time', { clientKey: 'a'.repeat(64), now: -1 }],
  ])('F5 refuses %s without writing', async (_label, input) => {
    expect(await workspaceStub().admitLoginAttempt(input)).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().refundLoginAttempt(input)).toEqual({ status: 'unavailable' });
    expect(await count('login_attempts')).toBe(0);
  });

  it('F5 fails closed on a corrupt window row and leaves it unchanged', async () => {
    const events = captureStoreEvents();
    await sql(`INSERT INTO login_attempts (scope_key, attempts, expires_at) VALUES ('global', 1, 'not-a-time')`);
    const client = randomHex64();
    expect(await admit(client, T0)).toEqual({ status: 'unavailable' });
    expect(await refund(client, T0)).toEqual({ status: 'unavailable' });
    expect(await count('login_attempts', 'scope_key = ?', client)).toBe(0);
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'workspace.store', reason: 'corrupt-record', operation: 'admitLoginAttempt' }),
      expect.objectContaining({ event: 'workspace.store', reason: 'corrupt-record', operation: 'refundLoginAttempt' }),
    ]));
  });
});

describe('F5 durable client against the real object', () => {
  it('F5 digests each admission identity into its own scope; no address reaches storage', async () => {
    const client = budget();
    const a = { kind: 'address', address: '203.0.113.7' } as const;
    const b = { kind: 'address', address: '2001:0db8:0000:0000:0000:0000:0000:0001' } as const;
    for (let attempt = 0; attempt < LOGIN_CLIENT_MAX_FAILURES; attempt += 1) {
      expect(await client.admitLoginAttempt({ identity: a, now: T0 })).toEqual({ status: 'admitted' });
    }
    expect(await client.admitLoginAttempt({ identity: a, now: T0 })).toEqual({
      status: 'limited',
      scope: 'client',
      retryAfterSeconds: LOGIN_CLIENT_WINDOW_SECONDS,
    });
    expect(await client.admitLoginAttempt({ identity: b, now: T0 })).toEqual({ status: 'admitted' });
    expect(await client.refundLoginAttempt({ identity: b, now: T0 })).toEqual({ status: 'refunded' });
    expect(await client.admitLoginAttempt({ identity: null, now: T0 })).toEqual({ status: 'admitted' });

    const keys = (await sql<{ scope_key: string }>(`SELECT scope_key FROM login_attempts ORDER BY scope_key`)).map((row) => row.scope_key);
    expect(keys).toEqual(['global', await loginClientKey(SALT, a), await loginClientKey(SALT, null)].sort());
    expect(JSON.stringify(keys)).not.toContain('203.0.113.7');
  });

  it('F5 RT-07 (owner amendment) an IPv6 client is its /64: every address and spelling in it shares one budget, another /64 does not', async () => {
    const client = budget();
    const sameSubnet = [
      '2001:db8:0:1::1',
      '2001:0db8:0000:0001:0000:0000:0000:0002',
      '2001:DB8:0:1:1234:5678:9abc:def0',
      '2001:db8:0:1:ffff:ffff:ffff:ffff',
    ];
    for (let attempt = 0; attempt < LOGIN_CLIENT_MAX_FAILURES; attempt += 1) {
      const address = sameSubnet[attempt % sameSubnet.length];
      expect(await client.admitLoginAttempt({ identity: { kind: 'address', address }, now: T0 })).toEqual({ status: 'admitted' });
    }
    // A host rotating through its /64 gets no fresh window.
    for (const address of [...sameSubnet, '2001:db8:0:1::abcd']) {
      expect(await client.admitLoginAttempt({ identity: { kind: 'address', address }, now: T0 })).toMatchObject({ status: 'limited', scope: 'client' });
    }
    for (const address of ['2001:db8:0:2::1', '2001:db8:1:1::1']) {
      expect(await client.admitLoginAttempt({ identity: { kind: 'address', address }, now: T0 })).toEqual({ status: 'admitted' });
    }

    const keys = await Promise.all(sameSubnet.map((address) => loginClientKey(SALT, { kind: 'address', address })));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(createHmac('sha256', SALT).update('login:v1\u0000address64:2001:0db8:0000:0001').digest('hex'));
    expect(await loginClientKey(SALT, { kind: 'address', address: '2001:db8:0:2::1' })).not.toBe(keys[0]);
    expect(await attempts(keys[0])).toBe(LOGIN_CLIENT_MAX_FAILURES);
  });

  it('F5 IPv4 keeps one budget per address; mapped IPv6 is the same IPv4 client; unknown and subrequest stay separate shared scopes', async () => {
    const v4 = await loginClientKey(SALT, { kind: 'address', address: '203.0.113.7' });
    // The subject for a normalized IPv4 address is unchanged by the /64 policy.
    expect(v4).toBe(createHmac('sha256', SALT).update('login:v1\u0000address:203.0.113.7').digest('hex'));
    expect(await loginClientKey(SALT, { kind: 'address', address: '203.0.113.8' })).not.toBe(v4);
    expect(await loginClientKey(SALT, { kind: 'address', address: '::ffff:203.0.113.7' })).toBe(v4);
    // A /64 subject never collides with an IPv4 subject or the shared scopes.
    const v6 = await loginClientKey(SALT, { kind: 'address', address: '::1' });
    const unknown = await loginClientKey(SALT, null);
    const subrequest = await loginClientKey(SALT, { kind: 'subrequest' });
    expect(new Set([v4, v6, unknown, subrequest]).size).toBe(4);
    expect(await loginClientKey(SALT, { kind: 'unknown', reason: 'invalid' })).toBe(unknown);
    expect(await loginClientKey(SALT, { kind: 'unknown', reason: 'missing' })).toBe(unknown);
    // An address that does not normalize is never its own budget.
    expect(await loginClientKey(SALT, { kind: 'address', address: '2001:db8::1%eth0' })).toBe(unknown);
  });

  it('F5 an object held for its identity still answers sign-in budget calls', async () => {
    const other = testEnv.WORKSPACE_STORE.getByName(`ws_${'f'.repeat(32)}`);
    expect(await other.readiness()).toEqual({ status: 'held', reason: 'workspace-identity-mismatch' });
    const clientKey = randomHex64();
    expect(await other.admitLoginAttempt({ clientKey, now: T0 })).toEqual({ status: 'admitted' });
    expect(await other.refundLoginAttempt({ clientKey, now: T0 })).toEqual({ status: 'refunded' });
  });
});
