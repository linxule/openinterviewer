// @vitest-environment node
//
// POST /api/auth on the Node standalone target (gap F5): the same 1 KiB body
// bound and failed-attempt budget as Cloudflare, kept in the deployment's
// Redis. Real configuration, session signing, identity derivation and budget
// client; only the Upstash client is a fake whose EVAL models the two scripts
// atomically (one step per call, replying a tick later so concurrent requests
// interleave). The scripts themselves run on real Redis in
// tests/integration/signInBudget.redis.test.ts. Hosted mode keeps its 404.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EvalCall = { script: string; keys: string[]; args: string[] };

const fakeRedis = vi.hoisted(() => ({
  eval: null as null | ((script: string, keys: string[], args: string[]) => Promise<unknown>),
}));
vi.mock('@upstash/redis', () => ({
  Redis: class {
    eval(script: string, keys: string[], args: string[]) {
      if (!fakeRedis.eval) throw new Error('unscripted Redis call');
      return fakeRedis.eval(script, keys, args);
    }
  },
}));

const cookieJar = vi.hoisted(() => new Map<string, { value: string; options?: unknown }>());
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: unknown) => {
      cookieJar.set(name, { value, options });
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  })),
}));

import { POST } from '@/app/api/auth/route';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth';
import { loginClientKey } from '@/lib/storage/durableObject';
import {
  ADMIT_LOGIN_SCRIPT,
  LOGIN_GLOBAL_KEY,
  REFUND_LOGIN_SCRIPT,
  loginClientRedisKey,
} from '@/lib/storage/redisLoginBudget';
import {
  LOGIN_CLIENT_MAX_FAILURES,
  LOGIN_CLIENT_WINDOW_SECONDS,
  LOGIN_GLOBAL_MAX_FAILURES,
} from '@/lib/storage/types';

const PASSWORD = 'synthetic-admin-password-1';
const WRONG = 'not-the-password-000';
const SALT = 'synthetic-rate-limit-salt-0123456789abcdef';
const ADDRESS = '203.0.113.7';
const NODE_ENV_VARS: Record<string, string> = {
  DEPLOYMENT_MODE: 'standalone',
  AI_TRANSPORT: 'direct',
  ADMIN_PASSWORD: PASSWORD,
  SESSION_SECRET: 'synthetic-session-secret-0123456789abcdefgh',
  PARTICIPANT_TOKEN_SECRET: 'synthetic-participant-secret-0123456789abcd',
  RATE_LIMIT_SALT: SALT,
  KV_REST_API_URL: 'https://synthetic-node-signin.upstash.io',
  KV_REST_API_TOKEN: 'synthetic-node-signin-token',
};
const MANAGED_ENV = [...Object.keys(NODE_ENV_VARS), 'DEPLOYMENT_TARGET', 'NODE_ENV'];

let savedEnv: Record<string, string | undefined> = {};
let evalCalls: EvalCall[] = [];
let logLines: string[] = [];
let windows = new Map<string, { count: number; expiresAt: number }>();
let clock = 0;

/** The scripts' contract (src/lib/storage/redisLoginBudget.ts), on a fake clock. */
function modelBudget(): void {
  const open = (key: string) => {
    const window = windows.get(key);
    if (window && window.expiresAt > clock) return window;
    windows.delete(key);
    return null;
  };
  fakeRedis.eval = async (script, keys, args) => {
    evalCalls.push({ script, keys, args });
    let reply: unknown;
    if (script === ADMIT_LOGIN_SCRIPT) {
      let limited = 0;
      let retry = 0;
      keys.forEach((key, index) => {
        const window = open(key);
        if (window && window.count >= Number(args[index * 2])) {
          const remaining = window.expiresAt - clock;
          if (remaining > retry) [limited, retry] = [index + 1, remaining];
        }
      });
      if (limited > 0) {
        reply = [0, limited, retry];
      } else {
        keys.forEach((key, index) => {
          const window = open(key);
          if (window) window.count += 1;
          else windows.set(key, { count: 1, expiresAt: clock + Number(args[index * 2 + 1]) });
        });
        reply = [1, 0, 0];
      }
    } else if (script === REFUND_LOGIN_SCRIPT) {
      for (const key of keys) {
        const window = open(key);
        if (!window || window.count <= 1) windows.delete(key);
        else window.count -= 1;
      }
      reply = 1;
    } else {
      throw new Error('unexpected script');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    return reply;
  };
}

function login(body: unknown, headers: Record<string, string> = { 'x-forwarded-for': ADDRESS }): Request {
  return new Request('https://interviews.example.org/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function from(address: string): Record<string, string> {
  return { 'x-forwarded-for': address };
}

function scripts(): string[] {
  return evalCalls.map((call) => (call.script === ADMIT_LOGIN_SCRIPT ? 'admit' : 'refund'));
}

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(NODE_ENV_VARS)) process.env[name] = value;
  delete process.env.DEPLOYMENT_TARGET;
  Reflect.deleteProperty(process.env, 'NODE_ENV');
  fakeRedis.eval = null;
  evalCalls = [];
  windows = new Map();
  clock = 1_000_000;
  cookieJar.clear();
  logLines = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    logLines.push(String(line));
  });
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logLines.push(String(line));
  });
});

afterEach(() => {
  for (const name of MANAGED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  const logged = logLines.join('\n');
  expect(logged).not.toContain(PASSWORD);
  expect(logged).not.toContain(ADDRESS);
  expect(logged).not.toContain(SALT);
});

describe('F5 Node standalone sign-in budget', () => {
  it('F5 admits (counts) the attempt before a correct password, then refunds it', async () => {
    modelBudget();
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await verifySessionToken(cookieJar.get(SESSION_COOKIE_NAME)!.value)).valid).toBe(true);
    expect(scripts()).toEqual(['admit', 'refund']);
    expect(windows.size).toBe(0);
  });

  it('F5 a wrong password stays counted under the global key and an HMAC client key, never the address', async () => {
    modelBudget();
    const response = await POST(login({ password: WRONG }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid password' });
    expect(cookieJar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(scripts()).toEqual(['admit']);
    const clientKey = await loginClientKey(SALT, { kind: 'address', address: ADDRESS });
    expect(evalCalls[0].keys).toEqual([LOGIN_GLOBAL_KEY, loginClientRedisKey(clientKey)]);
    expect(evalCalls[0].keys[1]).toMatch(/^rate-limit:login:client:900:[0-9a-f]{64}$/);
    expect(evalCalls[0].args).toEqual(['200', '3600000', '10', '900000']);
    expect(JSON.stringify(evalCalls)).not.toContain(ADDRESS);
    expect([...windows.values()].map((window) => window.count)).toEqual([1, 1]);
  });

  it('F5 a concurrent burst from one client reaches the password comparison at most 10 times', async () => {
    modelBudget();
    const responses = await Promise.all(Array.from({ length: 40 }, () => POST(login({ password: WRONG }))));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(LOGIN_CLIENT_MAX_FAILURES);
    expect(statuses.filter((status) => status === 429)).toHaveLength(40 - LOGIN_CLIENT_MAX_FAILURES);
    // A refused attempt counts in neither window.
    expect(windows.get(LOGIN_GLOBAL_KEY)?.count).toBe(LOGIN_CLIENT_MAX_FAILURES);

    // Once the burst is spent even the correct password waits for the window.
    const limited = await POST(login({ password: PASSWORD }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe(String(LOGIN_CLIENT_WINDOW_SECONDS));
    expect(await limited.json()).toEqual({
      error: 'Too many sign-in attempts. Please wait before trying again.',
      retryable: true,
    });
    expect(cookieJar.has(SESSION_COOKIE_NAME)).toBe(false);

    // The window is fixed: it ends 15 minutes after its first attempt.
    clock += LOGIN_CLIENT_WINDOW_SECONDS * 1000;
    expect((await POST(login({ password: PASSWORD }))).status).toBe(200);
  });

  it('F5 a correct password inside a burst is refunded, so only the failures stay counted', async () => {
    modelBudget();
    const responses = await Promise.all([
      ...Array.from({ length: 5 }, () => POST(login({ password: WRONG }))),
      POST(login({ password: PASSWORD })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401, 401, 401, 401, 401]);
    expect([...windows.values()].map((window) => window.count)).toEqual([5, 5]);
  });

  it('F5 RT-07 an IPv6 client is its /64; another /64 and another IPv4 address have their own budgets', async () => {
    modelBudget();
    for (let attempt = 0; attempt < LOGIN_CLIENT_MAX_FAILURES; attempt += 1) {
      const address = `2001:db8:0:1::${(attempt + 1).toString(16)}`;
      expect((await POST(login({ password: WRONG }, from(address)))).status).toBe(401);
    }
    expect((await POST(login({ password: PASSWORD }, from('2001:DB8:0:1:ffff::1')))).status).toBe(429);
    expect((await POST(login({ password: PASSWORD }, from('2001:db8:0:2::1')))).status).toBe(200);
    // IPv4 stays per address; the mapped spelling is the same client.
    for (let attempt = 0; attempt < LOGIN_CLIENT_MAX_FAILURES; attempt += 1) {
      await POST(login({ password: WRONG }, from(ADDRESS)));
    }
    expect((await POST(login({ password: PASSWORD }, from(`::ffff:${ADDRESS}`)))).status).toBe(429);
    expect((await POST(login({ password: PASSWORD }, from('203.0.113.8')))).status).toBe(200);
  });

  it('F5 uses the first address of the existing Vercel/XFF/x-real-ip chain', async () => {
    modelBudget();
    await POST(login({ password: WRONG }, { 'x-vercel-forwarded-for': `${ADDRESS}, 10.0.0.1`, 'x-forwarded-for': '198.51.100.1' }));
    await POST(login({ password: WRONG }, { 'x-real-ip': ADDRESS }));
    const clientKey = loginClientRedisKey(await loginClientKey(SALT, { kind: 'address', address: ADDRESS }));
    expect(evalCalls.map((call) => call.keys[1])).toEqual([clientKey, clientKey]);
  });

  it('F5 requests without a usable address share one unknown bucket', async () => {
    modelBudget();
    await POST(login({ password: WRONG }, {}));
    await POST(login({ password: WRONG }, from('client.example')));
    await POST(login({ password: WRONG }, from('203.0.113.7:443')));
    const keys = evalCalls.map((call) => call.keys[1]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(loginClientRedisKey(await loginClientKey(SALT, null)));
  });

  it('F5 the global window limits every client once 200 failures are counted', async () => {
    modelBudget();
    for (let client = 0; client < LOGIN_GLOBAL_MAX_FAILURES; client += 1) {
      const address = `198.51.${Math.floor(client / 250)}.${client % 250}`;
      expect((await POST(login({ password: WRONG }, from(address)))).status).toBe(401);
    }
    clock += 60_000;
    const limited = await POST(login({ password: PASSWORD }, from('192.0.2.1')));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe(String(3_600 - 60));
  });

  it.each([
    ['the script throws', () => {
      fakeRedis.eval = async () => {
        throw new Error('redis down');
      };
    }],
    ['the reply is not an array', () => {
      fakeRedis.eval = async () => 'OK';
    }],
    ['the limited reply has no positive retry time', () => {
      fakeRedis.eval = async () => [0, 2, 0];
    }],
    ['the limited reply names no scope', () => {
      fakeRedis.eval = async () => [0, 3, 5_000];
    }],
  ])('F5 fails closed with 503 when %s, even for the correct password', async (_label, arrange) => {
    arrange();
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Sign-in is temporarily unavailable. Please try again later.',
      retryable: true,
    });
    expect(cookieJar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(logLines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: 'kv.unavailable', route: '/api/auth', operation: 'login', status: 503, reason: 'unavailable',
    }));
  });

  it.each([
    ['RATE_LIMIT_SALT is missing', () => {
      delete process.env.RATE_LIMIT_SALT;
    }],
    ['RATE_LIMIT_SALT is shorter than 32 characters', () => {
      process.env.RATE_LIMIT_SALT = 's'.repeat(31);
    }],
    ['KV_REST_API_URL is missing', () => {
      delete process.env.KV_REST_API_URL;
    }],
    ['KV_REST_API_TOKEN is missing', () => {
      delete process.env.KV_REST_API_TOKEN;
    }],
  ])('F5 fails closed with 503 and no Redis call when %s', async (_label, arrange) => {
    modelBudget();
    arrange();
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(503);
    expect(evalCalls).toEqual([]);
    expect(cookieJar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(logLines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: 'kv.unavailable', operation: 'login', status: 503, reason: 'not-configured',
    }));
  });

  it('F5 a lost refund leaves the attempt counted and still signs in; the event carries no content', async () => {
    modelBudget();
    const admit = fakeRedis.eval!;
    fakeRedis.eval = async (script, keys, args) => {
      if (script === REFUND_LOGIN_SCRIPT) throw new Error('redis down');
      return admit(script, keys, args);
    };
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(200);
    expect(cookieJar.has(SESSION_COOKIE_NAME)).toBe(true);
    expect([...windows.values()].map((window) => window.count)).toEqual([1, 1]);
    expect(logLines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: 'kv.unavailable', route: '/api/auth', operation: 'login.refund', status: 200, reason: 'unavailable',
    }));
  });

  it.each([
    ['a body over 1 KiB', JSON.stringify({ password: PASSWORD, pad: 'x'.repeat(1024) }), 413],
    ['malformed JSON', '{"password":', 400],
    ['a JSON array', '[]', 400],
    ['a missing password', '{}', 400],
    ['a non-string password', '{"password":12345}', 400],
  ])('F5 refuses %s before any Redis call', async (_label, body, status) => {
    modelBudget();
    const response = await POST(login(body));
    expect(response.status).toBe(status);
    expect(evalCalls).toEqual([]);
  });

  it('keeps the 500 for a missing ADMIN_PASSWORD, before any Redis call', async () => {
    modelBudget();
    delete process.env.ADMIN_PASSWORD;
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(500);
    expect(evalCalls).toEqual([]);
  });
});

describe('hosted mode sign-in is unchanged', () => {
  it('answers 404 without reading the body or calling Redis', async () => {
    modelBudget();
    process.env.DEPLOYMENT_MODE = 'hosted';
    const response = await POST(login({ password: PASSWORD }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Password login is not available in hosted mode. Use OAuth to sign in.',
    });
    expect(evalCalls).toEqual([]);
  });
});
