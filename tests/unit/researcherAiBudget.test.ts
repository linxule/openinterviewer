// @vitest-environment node
// Researcher AI budget on the standalone targets (D15): the policy, the
// session and workspace subjects, and the HTTP mapping, run through the real
// Redis workspace store over an in-memory model of its limiter script. The
// durable object's own windows are tested in tests/workers/researcherAi.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import { HOSTED_AI_RATE_LIMIT_POLICY } from '@/lib/platformAiRateLimit';
import {
  researcherAiBudgetResponse,
  researcherAiCounters,
  STANDALONE_RESEARCHER_AI_POLICY,
} from '@/lib/researcherAiBudget';
import type { RedisPort } from '@/lib/redisPort';
import { createRedisWorkspaceStore } from '@/lib/storage/redis';
import type { AdmissionOutcome, ResearcherAiOperation, WorkspaceStorePort } from '@/lib/storage/types';

const ROUTE = '/api/synthesis/aggregate';
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const OPERATIONS = Object.keys(STANDALONE_RESEARCHER_AI_POLICY) as ResearcherAiOperation[];

/** The limiter script's semantics (check every key, then INCR/EXPIRE every key), in memory. */
function limiterPort() {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  const evalMock = vi.fn(async (_script: string, keys: string[], args: string[]) => {
    const now = Date.now();
    for (let i = 0; i < keys.length; i += 1) {
      const row = windows.get(keys[i]);
      const count = row && row.expiresAt > now ? row.count : 0;
      if (count >= Number(args[i * 2])) return [0, i + 1, Math.ceil((row!.expiresAt - now) / 1000)];
    }
    for (let i = 0; i < keys.length; i += 1) {
      const row = windows.get(keys[i]);
      if (row && row.expiresAt > now) row.count += 1;
      else windows.set(keys[i], { count: 1, expiresAt: now + Number(args[i * 2 + 1]) * 1000 });
    }
    return [1, 0, 0];
  });
  return { port: { eval: evalMock } as unknown as RedisPort, evalMock, windows };
}

async function sessionRequest(): Promise<Request> {
  const token = await createSessionToken();
  return new Request(`http://localhost${ROUTE}`, {
    method: 'POST',
    headers: { Cookie: `theme=dark; ${SESSION_COOKIE_NAME}=${token}` },
  });
}

let limiter: ReturnType<typeof limiterPort>;
let store: WorkspaceStorePort;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.stubEnv('DEPLOYMENT_MODE', 'standalone');
  vi.stubEnv('SESSION_SECRET', 'synthetic-session-secret-0123456789abcdefgh');
  limiter = limiterPort();
  store = createRedisWorkspaceStore(limiter.port, { researcherId: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('STANDALONE_RESEARCHER_AI_POLICY (D15)', () => {
  it('covers every hosted AI operation with a session and a workspace scope and no network scope', () => {
    expect(OPERATIONS.sort()).toEqual(Object.keys(HOSTED_AI_RATE_LIMIT_POLICY).sort());
    for (const operation of OPERATIONS) {
      const policy = STANDALONE_RESEARCHER_AI_POLICY[operation];
      expect(Object.keys(policy).sort()).toEqual(['researcher', 'session']);
      expect(policy.session.maximum).toBeLessThanOrEqual(policy.researcher.maximum);
      expect(policy.session.windowSeconds).toBeLessThanOrEqual(policy.researcher.windowSeconds);
    }
  });

  it('keeps the hosted numbers for the researcher-only operations', () => {
    for (const operation of ['aggregate', 'followup', 'analysis'] as const) {
      expect(STANDALONE_RESEARCHER_AI_POLICY[operation]).toEqual({
        session: HOSTED_AI_RATE_LIMIT_POLICY[operation].session,
        researcher: HOSTED_AI_RATE_LIMIT_POLICY[operation].researcher,
      });
    }
  });
});

describe('researcherAiBudgetResponse on the Node standalone target (D15)', () => {
  it('charges a digested session scope and the workspace scope, never the raw session token', async () => {
    const request = await sessionRequest();
    const token = request.headers.get('cookie')!.split(`${SESSION_COOKIE_NAME}=`)[1];

    expect(await researcherAiBudgetResponse(request, 'aggregate', store, ROUTE)).toBeNull();

    const [, keys, args] = limiter.evalMock.mock.calls[0];
    expect(keys).toEqual([
      expect.stringMatching(/^researcher-ai:aggregate:session:3600:[a-f0-9]{64}$/),
      'researcher-ai:aggregate:researcher:86400:workspace',
    ]);
    expect(args).toEqual(['20', '3600', '100', '86400']);
    expect(JSON.stringify(limiter.evalMock.mock.calls)).not.toContain(token);
  });

  it('refuses the session at its maximum with 429 and Retry-After, charging no other scope', async () => {
    const request = await sessionRequest();
    const { maximum } = STANDALONE_RESEARCHER_AI_POLICY.synthesis.session;
    for (let i = 0; i < maximum; i += 1) {
      expect(await researcherAiBudgetResponse(request.clone(), 'synthesis', store, ROUTE)).toBeNull();
    }
    vi.setSystemTime(T0 + 60_000);

    const limited = await researcherAiBudgetResponse(request.clone(), 'synthesis', store, ROUTE);

    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('Retry-After')).toBe('3540');
    await expect(limited?.json()).resolves.toEqual({
      error: 'Too many AI requests from this workspace. Please wait before trying again.',
      retryable: true,
    });
    expect(limiter.windows.get('researcher-ai:synthesis:researcher:86400:workspace')?.count).toBe(maximum);
  });

  it('shares the workspace scope across sessions: a new sign-in does not reset it', async () => {
    const policy = STANDALONE_RESEARCHER_AI_POLICY.aggregate;
    const sessions = policy.researcher.maximum / policy.session.maximum;
    for (let s = 0; s < sessions; s += 1) {
      vi.setSystemTime(T0 + s * 1_000); // a later iat signs a new session token
      const request = await sessionRequest();
      for (let i = 0; i < policy.session.maximum; i += 1) {
        expect(await researcherAiBudgetResponse(request.clone(), 'aggregate', store, ROUTE)).toBeNull();
      }
    }
    vi.setSystemTime(T0 + sessions * 1_000);

    const fresh = await researcherAiBudgetResponse(await sessionRequest(), 'aggregate', store, ROUTE);

    expect(fresh?.status).toBe(429);
    // Other operations keep their own budgets.
    expect(await researcherAiBudgetResponse(await sessionRequest(), 'followup', store, ROUTE)).toBeNull();
  });

  it('opens a new window once the old one expires', async () => {
    const request = await sessionRequest();
    const { maximum } = STANDALONE_RESEARCHER_AI_POLICY.greeting.session;
    for (let i = 0; i < maximum; i += 1) await researcherAiBudgetResponse(request.clone(), 'greeting', store, ROUTE);
    expect((await researcherAiBudgetResponse(request.clone(), 'greeting', store, ROUTE))?.status).toBe(429);

    vi.setSystemTime(T0 + STANDALONE_RESEARCHER_AI_POLICY.greeting.session.windowSeconds * 1000);

    expect(await researcherAiBudgetResponse(request.clone(), 'greeting', store, ROUTE)).toBeNull();
  });

  it.each([
    ['no cookie', new Request(`http://localhost${ROUTE}`)],
    ['a forged session cookie', new Request(`http://localhost${ROUTE}`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=forged` } })],
  ])('fails closed with 503 and charges nothing for %s', async (_label, request) => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await researcherAiBudgetResponse(request, 'analysis', store, ROUTE);

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      error: 'Unable to verify AI request limits. Please try again later.',
      retryable: true,
    });
    expect(limiter.evalMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toContain('identity-missing');
  });

  it('fails closed with 503 when the store is unavailable or throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    limiter.evalMock.mockRejectedValueOnce(new Error('synthetic outage'));
    expect((await researcherAiBudgetResponse(await sessionRequest(), 'interview', store, ROUTE))?.status).toBe(503);

    const throwing = { admitResearcherAiRequest: vi.fn(async (): Promise<AdmissionOutcome> => { throw new Error('boom'); }) };
    expect((await researcherAiBudgetResponse(await sessionRequest(), 'interview', throwing, ROUTE))?.status).toBe(503);
  });

  it('maps a held workspace to the held-workspace response', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const held = { admitResearcherAiRequest: vi.fn(async (): Promise<AdmissionOutcome> => ({ status: 'held', reason: 'maintenance' })) };

    const response = await researcherAiBudgetResponse(await sessionRequest(), 'followup', held, ROUTE);

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ reason: 'maintenance', retryable: true });
  });

  it('never charges in hosted mode, where HOSTED_AI_RATE_LIMIT_POLICY applies', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'hosted');
    const admit = vi.fn();

    expect(await researcherAiBudgetResponse(new Request(`http://localhost${ROUTE}`), 'aggregate', { admitResearcherAiRequest: admit }, ROUTE))
      .toBeNull();
    expect(admit).not.toHaveBeenCalled();
  });

  it('builds no counters for a hosted session token', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'hosted');
    const hostedToken = await createSessionToken('researcher-a');
    vi.stubEnv('DEPLOYMENT_MODE', 'standalone');

    const request = new Request(`http://localhost${ROUTE}`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${hostedToken}` } });
    expect(await researcherAiCounters(request, 'aggregate')).toBeNull();
  });
});
