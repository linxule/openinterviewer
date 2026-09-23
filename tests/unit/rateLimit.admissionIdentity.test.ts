// @vitest-environment node

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import {
  consumeParticipantRateLimits,
  getParticipantRateLimitCounters,
  getSavePersistRatePlan,
  isSubrequestAdmission,
  ParticipantAdmissionError,
  participantAdmissionRefusal,
  participantAdmissionResponse,
  participantRateLimitResponse,
  participantStoreAdmissionResponse,
  savePersistRatePlanOrResponse,
} from '@/lib/rateLimit';
import type { AdmissionInput, AdmissionOutcome } from '@/lib/storage/types';
import {
  WORKER_INVOCATION_ACCESSOR,
  type AdmissionIdentity,
  type WorkerInvocation,
} from '@/lib/runtime/workerInvocation';

const CF_SALT = 'cloudflare-rate-limit-salt-0123456789abcdef';
const AUTHORITY = { sessionId: 'session-a', linkId: 'link-a', researcherId: null };

type AccessorGlobal = { [WORKER_INVOCATION_ACCESSOR]?: () => WorkerInvocation | null };

function bucket(salt: string, address: string): string {
  return createHmac('sha256', salt).update(address).digest('hex').slice(0, 24);
}

function clientKey(request: Request, operation: 'greeting' | 'interview' = 'interview'): string {
  const counters = getParticipantRateLimitCounters(request, 'study-a', operation, AUTHORITY);
  const key = counters?.find(counter => counter.key.includes(':client:'))?.key;
  if (!key) throw new Error('client counter missing');
  return key.slice(key.lastIndexOf(':') + 1);
}

function enterCloudflare(identity: AdmissionIdentity | null, env: Record<string, unknown> = { RATE_LIMIT_SALT: CF_SALT }) {
  vi.stubEnv('DEPLOYMENT_TARGET', 'cloudflare');
  const invocation: WorkerInvocation = { env, identity, source: 'fetch' };
  (globalThis as AccessorGlobal)[WORKER_INVOCATION_ACCESSOR] = () => invocation;
  return invocation;
}

type ConsoleSpy = MockInstance<(...args: unknown[]) => void>;

function loggedEvents(spy: ConsoleSpy): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map(call => call[0])
    .filter((line): line is string => typeof line === 'string')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function evalClient(reply: unknown = [1, 0, 0]) {
  const evalMock = vi.fn().mockResolvedValue(reply);
  return { client: { eval: evalMock } as unknown as RedisPort, evalMock };
}

function admissionStore(outcome: AdmissionOutcome | Error = { status: 'admitted' }) {
  const admitMock = vi.fn<(input: AdmissionInput) => Promise<AdmissionOutcome>>(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { store: { admitParticipantRequest: admitMock }, admitMock };
}

let errorSpy: ConsoleSpy;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('DEPLOYMENT_TARGET', '');
  vi.stubEnv('RATE_LIMIT_SALT', '');
  vi.stubEnv('PARTICIPANT_TOKEN_SECRET', '');
});

afterEach(() => {
  delete (globalThis as AccessorGlobal)[WORKER_INVOCATION_ACCESSOR];
  vi.unstubAllEnvs();
});

describe('Node admission identity (RT-07)', () => {
  it('RT-07: keeps the existing forwarding-header chain and first-element rule byte for byte', () => {
    vi.stubEnv('RATE_LIMIT_SALT', 'node-salt');
    const vercel = new Request('http://localhost/api/interview', {
      headers: {
        'x-vercel-forwarded-for': ' 198.51.100.7 , 10.0.0.1',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '192.0.2.4',
      },
    });
    expect(clientKey(vercel)).toBe(bucket('node-salt', '198.51.100.7'));

    const forwarded = new Request('http://localhost/api/interview', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2', 'x-real-ip': '192.0.2.4' },
    });
    expect(clientKey(forwarded)).toBe(bucket('node-salt', '203.0.113.9'));

    const realIp = new Request('http://localhost/api/interview', { headers: { 'x-real-ip': '192.0.2.4' } });
    expect(clientKey(realIp)).toBe(bucket('node-salt', '192.0.2.4'));

    expect(clientKey(new Request('http://localhost/api/interview'))).toBe(bucket('node-salt', 'unknown'));
    const blank = new Request('http://localhost/api/interview', { headers: { 'x-forwarded-for': ' , 10.0.0.2' } });
    expect(clientKey(blank)).toBe(bucket('node-salt', 'unknown'));
  });

  it('RT-07: keeps the Node salt fallback chain unchanged', () => {
    const request = new Request('http://localhost/api/interview', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(clientKey(request)).toBe(bucket('openinterviewer-rate-limit', '203.0.113.9'));
    vi.stubEnv('PARTICIPANT_TOKEN_SECRET', 'participant-secret');
    expect(clientKey(request)).toBe(bucket('participant-secret', '203.0.113.9'));
    vi.stubEnv('RATE_LIMIT_SALT', 'explicit-salt');
    expect(clientKey(request)).toBe(bucket('explicit-salt', '203.0.113.9'));
  });

  it('RT-07: Node never reports a subrequest identity', () => {
    expect(isSubrequestAdmission()).toBe(false);
    expect(participantAdmissionRefusal('greeting')).toBeNull();
  });

  it('RT-07: an unsupported deployment target fails the limiter closed without touching Redis', async () => {
    vi.stubEnv('DEPLOYMENT_TARGET', 'workers');
    const { client, evalMock } = evalClient();
    const response = await participantRateLimitResponse(
      new Request('http://localhost/api/interview'), 'study-a', 'interview', client, AUTHORITY,
    );
    expect(response?.status).toBe(503);
    expect(evalMock).not.toHaveBeenCalled();
  });
});

describe('Cloudflare admission identity (RT-07)', () => {
  it('RT-07: keys the client budget by the invocation address and ignores forwarding headers', () => {
    enterCloudflare({ kind: 'address', address: '203.0.113.9' });
    const spoofed = new Request('http://localhost/api/interview', {
      headers: { 'x-forwarded-for': '198.51.100.99', 'x-vercel-forwarded-for': '192.0.2.1', 'x-real-ip': '192.0.2.2' },
    });
    expect(clientKey(spoofed)).toBe(bucket(CF_SALT, '203.0.113.9'));
    expect(clientKey(new Request('http://localhost/api/interview'))).toBe(bucket(CF_SALT, '203.0.113.9'));
    expect(loggedEvents(errorSpy)).toEqual([]);
  });

  it('RT-07: a missing identity uses the salted unknown bucket and reports it once per invocation without an address', () => {
    enterCloudflare({ kind: 'unknown', reason: 'missing' });
    const request = new Request('http://localhost/api/interview', { headers: { 'x-forwarded-for': '198.51.100.99' } });

    expect(clientKey(request, 'interview')).toBe(bucket(CF_SALT, 'unknown'));
    expect(clientKey(request, 'greeting')).toBe(bucket(CF_SALT, 'unknown'));
    const plan = getSavePersistRatePlan(request, 'study-a', AUTHORITY);
    expect(plan).toHaveLength(4);

    const events = loggedEvents(errorSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'admission.identity', reason: 'identity-missing', operation: 'interview' });
    expect(JSON.stringify(events)).not.toContain('198.51.100.99');
  });

  it('RT-07: an invalid identity uses the same unknown bucket and reports identity-invalid', () => {
    enterCloudflare({ kind: 'unknown', reason: 'invalid' });
    expect(clientKey(new Request('http://localhost/api/greeting'), 'greeting')).toBe(bucket(CF_SALT, 'unknown'));
    expect(loggedEvents(errorSpy)).toEqual([
      expect.objectContaining({ event: 'admission.identity', reason: 'identity-invalid', operation: 'greeting' }),
    ]);
  });

  it('RT-07: an absent invocation context on the Cloudflare target is treated as a missing identity', () => {
    vi.stubEnv('DEPLOYMENT_TARGET', 'cloudflare');
    vi.stubEnv('RATE_LIMIT_SALT', CF_SALT);
    expect(clientKey(new Request('http://localhost/api/interview'))).toBe(bucket(CF_SALT, 'unknown'));
    expect(loggedEvents(errorSpy)).toEqual([
      expect.objectContaining({ event: 'admission.identity', reason: 'identity-missing' }),
    ]);
  });

  it('RT-07: RATE_LIMIT_SALT is mandatory: no participant-secret or constant fallback, limiter fails closed', async () => {
    enterCloudflare({ kind: 'address', address: '203.0.113.9' }, {});
    vi.stubEnv('PARTICIPANT_TOKEN_SECRET', 'participant-secret-that-must-not-be-used');
    const request = new Request('http://localhost/api/interview');

    expect(() => getParticipantRateLimitCounters(request, 'study-a', 'interview', AUTHORITY))
      .toThrow(ParticipantAdmissionError);
    expect(() => getSavePersistRatePlan(request, 'study-a', AUTHORITY)).toThrow(ParticipantAdmissionError);

    const { client, evalMock } = evalClient();
    const response = await participantRateLimitResponse(request, 'study-a', 'interview', client, AUTHORITY);
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error: 'Unable to verify request limits. Please try again later.',
      retryable: true,
    });
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('RT-07: a salt shorter than the workspace minimum is refused like a missing one', () => {
    enterCloudflare({ kind: 'address', address: '203.0.113.9' }, { RATE_LIMIT_SALT: 'too-short' });
    expect(() => getParticipantRateLimitCounters(new Request('http://localhost/'), 'study-a', 'greeting', AUTHORITY))
      .toThrow(ParticipantAdmissionError);
  });

  it('RT-07: the invocation env supplies the salt when the process env does not', () => {
    enterCloudflare({ kind: 'address', address: '2001:0db8:0000:0000:0000:0000:0000:0001' });
    expect(clientKey(new Request('http://localhost/api/interview')))
      .toBe(bucket(CF_SALT, '2001:0db8:0000:0000:0000:0000:0000:0001'));
  });

  it('RT-07: the save plan keys every row with the Cloudflare salt and the invocation address', () => {
    enterCloudflare({ kind: 'address', address: '203.0.113.9' });
    const nowMs = 1_700_000_123_000;
    const plan = getSavePersistRatePlan(new Request('http://localhost/'), 'study-a', AUTHORITY, nowMs);
    const clientSubject = `study-a:${bucket(CF_SALT, '203.0.113.9')}`;
    const clientPlanId = createHmac('sha256', CF_SALT).update(`save:client:3600:${clientSubject}`).digest('hex');
    expect(plan?.[1]).toEqual({
      key: `interview-rate:${clientPlanId}:${Math.floor(nowMs / 1000 / 3600) * 3600}`,
      maximum: 20,
      windowSeconds: 3_600,
      windowStart: Math.floor(nowMs / 1000 / 3600) * 3600,
    });
    expect(plan?.every(row => row.key.startsWith('interview-rate:'))).toBe(true);
  });

  it('RT-07: a Workers subrequest is refused with 403 before any budget or provider use', async () => {
    enterCloudflare({ kind: 'subrequest' });
    expect(isSubrequestAdmission()).toBe(true);

    const refusal = participantAdmissionRefusal('interview');
    expect(refusal?.status).toBe(403);
    expect(await refusal?.json()).toEqual({
      error: 'Participant requests must come directly from a browser.',
      retryable: false,
    });

    expect(() => getParticipantRateLimitCounters(new Request('http://localhost/'), 'study-a', 'interview', AUTHORITY))
      .toThrow(ParticipantAdmissionError);
    expect(() => getSavePersistRatePlan(new Request('http://localhost/'), 'study-a', AUTHORITY))
      .toThrow(ParticipantAdmissionError);

    const { client, evalMock } = evalClient();
    const limited = await participantRateLimitResponse(
      new Request('http://localhost/'), 'study-a', 'greeting', client, AUTHORITY,
    );
    expect(limited?.status).toBe(403);
    expect(evalMock).not.toHaveBeenCalled();
    expect(loggedEvents(errorSpy)).toEqual([
      expect.objectContaining({ event: 'admission.identity', reason: 'subrequest-rejected', operation: 'interview' }),
      expect.objectContaining({ event: 'admission.identity', reason: 'subrequest-rejected', operation: 'greeting' }),
    ]);
  });
});

describe('store-path participant admission (RT-07, ST-06)', () => {
  it('RT-07: a Workers subrequest is refused with 403 before the store is consulted', async () => {
    enterCloudflare({ kind: 'subrequest' });
    const { store, admitMock } = admissionStore();
    const response = await participantStoreAdmissionResponse(
      new Request('http://localhost/'), 'study-a', 'interview', store, AUTHORITY,
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: 'Participant requests must come directly from a browser.',
      retryable: false,
    });
    expect(admitMock).not.toHaveBeenCalled();
    expect(loggedEvents(errorSpy)).toEqual([
      expect.objectContaining({ event: 'admission.identity', reason: 'subrequest-rejected', operation: 'interview' }),
    ]);
  });

  it('RT-07: a missing Cloudflare salt fails closed with 503 before the store is consulted', async () => {
    enterCloudflare({ kind: 'address', address: '203.0.113.9' }, {});
    const { store, admitMock } = admissionStore();
    const response = await participantStoreAdmissionResponse(
      new Request('http://localhost/'), 'study-a', 'greeting', store, AUTHORITY,
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error: 'Unable to verify request limits. Please try again later.',
      retryable: true,
    });
    expect(admitMock).not.toHaveBeenCalled();
    expect(loggedEvents(errorSpy)).toEqual([
      expect.objectContaining({ event: 'route.failure', reason: 'not-configured', operation: 'greeting', status: 503 }),
    ]);
  });

  it('ST-06: passes the Cloudflare counters to the store and maps its outcome with the shared HTTP mapping', async () => {
    enterCloudflare({ kind: 'address', address: '203.0.113.9' });
    const request = new Request('http://localhost/');
    const { store, admitMock } = admissionStore();
    expect(await participantStoreAdmissionResponse(request, 'study-a', 'interview', store, AUTHORITY, 1_234))
      .toBeNull();
    expect(admitMock).toHaveBeenCalledWith({
      operation: 'interview',
      counters: getParticipantRateLimitCounters(request, 'study-a', 'interview', AUTHORITY),
      now: 1_234,
    });

    const limited = await participantStoreAdmissionResponse(
      request, 'study-a', 'interview',
      admissionStore({ status: 'limited', rejectedIndex: 1, retryAfterSeconds: 9 }).store, AUTHORITY,
    );
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('Retry-After')).toBe('9');
    const held = await participantStoreAdmissionResponse(
      request, 'study-a', 'interview', admissionStore({ status: 'held', reason: 'maintenance' }).store, AUTHORITY,
    );
    expect(held?.status).toBe(503);
  });

  it('ST-06: incomplete authority is 401 and a throwing store fails closed with 503', async () => {
    enterCloudflare({ kind: 'address', address: '203.0.113.9' });
    const { store, admitMock } = admissionStore();
    const incomplete = await participantStoreAdmissionResponse(
      new Request('http://localhost/'), 'study-a', 'interview', store, { sessionId: 'session-a' },
    );
    expect(incomplete?.status).toBe(401);
    expect(admitMock).not.toHaveBeenCalled();

    const failing = await participantStoreAdmissionResponse(
      new Request('http://localhost/'), 'study-a', 'greeting', admissionStore(new Error('binding lost')).store, AUTHORITY,
    );
    expect(failing?.status).toBe(503);
    expect(loggedEvents(errorSpy)).toEqual([
      expect.objectContaining({ event: 'workspace.store', operation: 'greeting', errorType: 'Error' }),
    ]);
    expect(JSON.stringify(loggedEvents(errorSpy))).not.toContain('binding lost');
  });
});

describe('save rate plan decision (RT-07)', () => {
  it('RT-07: a Workers subrequest save is refused with 403 instead of throwing', async () => {
    enterCloudflare({ kind: 'subrequest' });
    const decision = savePersistRatePlanOrResponse(new Request('http://localhost/'), 'study-a', AUTHORITY);
    expect(decision.status).toBe('refused');
    if (decision.status !== 'refused') return;
    expect(decision.response.status).toBe(403);
    expect(await decision.response.json()).toEqual({
      error: 'Participant requests must come directly from a browser.',
      retryable: false,
    });
    expect(loggedEvents(errorSpy)).toEqual([
      expect.objectContaining({ event: 'admission.identity', reason: 'subrequest-rejected', operation: 'save' }),
    ]);
  });

  it('RT-07: a missing Cloudflare salt refuses the save with 503', async () => {
    enterCloudflare({ kind: 'address', address: '203.0.113.9' }, {});
    const decision = savePersistRatePlanOrResponse(new Request('http://localhost/'), 'study-a', AUTHORITY);
    expect(decision.status === 'refused' && decision.response.status).toBe(503);
  });

  it('RT-07: an unsupported deployment target refuses the save with 503', () => {
    vi.stubEnv('DEPLOYMENT_TARGET', 'workers');
    const decision = savePersistRatePlanOrResponse(new Request('http://localhost/'), 'study-a', AUTHORITY);
    expect(decision.status === 'refused' && decision.response.status).toBe(503);
  });

  it('RT-07: incomplete authority is 401; a usable identity returns the same rows as getSavePersistRatePlan', async () => {
    enterCloudflare({ kind: 'address', address: '203.0.113.9' });
    const request = new Request('http://localhost/');
    const incomplete = savePersistRatePlanOrResponse(request, 'study-a', { sessionId: 'session-a' });
    expect(incomplete.status === 'refused' && incomplete.response.status).toBe(401);

    const nowMs = 1_700_000_123_000;
    expect(savePersistRatePlanOrResponse(request, 'study-a', AUTHORITY, nowMs)).toEqual({
      status: 'planned',
      rows: getSavePersistRatePlan(request, 'study-a', AUTHORITY, nowMs),
    });
  });
});

describe('participant limiter decision (ST-06)', () => {
  const counters = [
    { key: 'rate-limit:interview:session:3600:s', maximum: 60, windowSeconds: 3_600 },
    { key: 'rate-limit:interview:client:3600:c', maximum: 60, windowSeconds: 3_600 },
    { key: 'rate-limit:interview:study:86400:x', maximum: 5_000, windowSeconds: 86_400 },
  ];

  it('ST-06: sends the existing check-all-then-charge script with counters in order', async () => {
    const { client, evalMock } = evalClient([1, 0, 0]);
    expect(await consumeParticipantRateLimits(client, counters)).toEqual({ allowed: true });
    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain('if count >= maximum then');
    expect(script).toContain("redis.call('INCR', KEYS[i])");
    expect(keys).toEqual(counters.map(counter => counter.key));
    expect(args).toEqual(['60', '3600', '60', '3600', '5000', '86400']);
  });

  it('ST-06: maps the 1-based script index to a 0-based counter and keeps the Retry-After rule', async () => {
    expect(await consumeParticipantRateLimits(evalClient([0, 2, 17]).client, counters))
      .toEqual({ allowed: false, rejectedIndex: 1, retryAfterSeconds: 17 });
    expect(await consumeParticipantRateLimits(evalClient([0, 3, -1]).client, counters))
      .toEqual({ allowed: false, rejectedIndex: 2, retryAfterSeconds: 86_400 });
    expect(await consumeParticipantRateLimits(evalClient([0, 1, 0]).client, counters))
      .toEqual({ allowed: false, rejectedIndex: 0, retryAfterSeconds: 3_600 });
  });

  it('ST-06: a malformed script reply is an error, never an admission', async () => {
    for (const reply of [null, 'OK', [0], [0, 0, 5], [0, 4, 5], [0, 1.5, 5], ['1', 0, 0]]) {
      await expect(consumeParticipantRateLimits(evalClient(reply).client, counters)).rejects.toThrow();
    }
  });

  it('ST-06: one HTTP mapping serves every admission outcome', async () => {
    expect(participantAdmissionResponse({ status: 'admitted' })).toBeNull();
    const limited = participantAdmissionResponse({ status: 'limited', rejectedIndex: 1, retryAfterSeconds: 42 });
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('Retry-After')).toBe('42');
    expect(await limited?.json()).toEqual({
      error: 'Too many AI requests. Please wait before trying again.',
      retryable: true,
    });
    expect(participantAdmissionResponse({ status: 'unavailable' })?.status).toBe(503);
    expect(participantAdmissionResponse({ status: 'held', reason: 'maintenance' })?.status).toBe(503);
  });
});
