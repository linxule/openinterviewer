// The participant routes against the real WorkspaceStore object (RT-06,
// RT-09, ST-02/03, JOB-01/02, OPS-01). Unlike the unit tier's scripted fake,
// every RPC here crosses the real Durable Object client into the production
// object on local SQLite, so the tests fail when a route's request drifts from
// what the object accepts (frozen inputs, consent binding, link and job
// identifiers, rate-plan keys). Only the provider factory, `after()` and the
// researcher's cookie store are doubles; no provider request is ever made.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reset } from 'cloudflare:test';

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
  })),
}));

// Page-only redirects (researcherAccess.ts); the React client bundle behind
// next/navigation does not load outside Next.
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

const afterMock = vi.hoisted(() => vi.fn());
vi.mock('next/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('next/server')>(),
  after: afterMock,
}));

const providerFactory = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/providers')>(),
  getInterviewProvider: providerFactory,
}));

import { GET as exchangeGET, POST as generateLinkPOST } from '../../src/app/api/generate-link/route';
import { DELETE as linksDELETE } from '../../src/app/api/studies/[id]/participant-links/route';
import { POST as consentPOST } from '../../src/app/api/consent/route';
import { POST as greetingPOST } from '../../src/app/api/greeting/route';
import { POST as interviewPOST } from '../../src/app/api/interview/route';
import { POST as savePOST } from '../../src/app/api/interviews/save/route';
import { createSessionToken, PARTICIPANT_SESSION_HEADER_NAME, SESSION_COOKIE_NAME } from '../../src/lib/auth';
import { DEFAULT_MODEL_BY_PROVIDER } from '../../src/lib/providerRegistry';
import { WORKER_INVOCATION_ACCESSOR, WORKER_RUNTIME_MARKER, type WorkerInvocation } from '../../src/lib/runtime/workerInvocation';
import { alarmAt, createStudy, DAY, setMaintenance, sha256Hex, sql, T0, testEnv } from './fixtures';

const ADMIN_PASSWORD = 'synthetic-admin-password-0123456789';
const ORIGIN = String(testEnv.APP_BASE_URL);
// The study's explicit model; deliberately not the provider default.
const STUDY_MODEL = 'gpt-5.6-sol';

const runtime = globalThis as unknown as Record<symbol, unknown>;

const provider = {
  getInterviewGreeting: vi.fn(async () => 'A synthetic greeting.'),
  generateInterviewResponse: vi.fn(async () => ({
    message: 'A synthetic follow-up.',
    questionAddressed: null,
    phaseTransition: null,
    profileUpdates: [],
    shouldConclude: false,
  })),
};

const history = [
  { id: 'm1', role: 'ai', content: 'What was onboarding like?', timestamp: T0 - 2_000 },
  { id: 'm2', role: 'user', content: 'A synthetic answer.', timestamp: T0 - 1_000 },
];
const interviewBody = {
  history,
  participantProfile: null,
  questionProgress: { questionsAsked: [], total: 1, currentPhase: 'background', isComplete: false },
  currentContext: '',
};
const saveBody = (studyId: string) => ({
  id: 'browser-id',
  studyId,
  transcript: history,
  participantProfile: null,
  behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
  createdAt: T0 - DAY,
});

beforeEach(async () => {
  await reset();
  cookieJar.clear();
  // Jobs committed by a save are due at T0, far ahead of real time, so the
  // object's alarm never dispatches one to the Queue during a run.
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  vi.stubEnv('ADMIN_PASSWORD', ADMIN_PASSWORD);
  const invocation: WorkerInvocation = {
    env: { ...testEnv, ADMIN_PASSWORD },
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtime[WORKER_RUNTIME_MARKER] = true;
  runtime[WORKER_INVOCATION_ACCESSOR] = () => invocation;
  providerFactory.mockReturnValue(provider);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  delete runtime[WORKER_INVOCATION_ACCESSOR];
  delete runtime[WORKER_RUNTIME_MARKER];
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  afterMock.mockReset();
  providerFactory.mockReset();
});

async function researcherRequest(url: string, method: string, body?: unknown): Promise<Request> {
  const token = await createSessionToken();
  cookieJar.set(SESSION_COOKIE_NAME, token);
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Session = { cookie: string; handle: string; aiTransport: string };

function participantRequest(path: string, session: Session, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      [PARTICIPANT_SESSION_HEADER_NAME]: session.handle,
    },
    body: JSON.stringify(body),
  });
}

async function mintLink(studyId: string): Promise<Response> {
  // A request host that is not the deployment origin: the URL must still use APP_BASE_URL.
  return generateLinkPOST(await researcherRequest('https://attacker.invalid/api/generate-link', 'POST', {
    studyConfig: { id: studyId },
  }));
}

async function exchange(code: string): Promise<{ response: Response; session: Session | null }> {
  const response = await exchangeGET(new Request(`${ORIGIN}/api/generate-link?token=${code}`));
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 200 || !setCookie) return { response, session: null };
  const body = await response.clone().json() as { data: { sessionHandle: string; aiTransport: string } };
  return {
    response,
    session: { cookie: setCookie.split(';')[0], handle: body.data.sessionHandle, aiTransport: body.data.aiTransport },
  };
}

/** The consent page echoes the transport it disclosed (from the exchange). */
function consentBody(session: Session, studyId: string) {
  return { studyId, disclosedTransport: session.aiTransport };
}

async function heldParticipantResponses(session: Session, studyId: string) {
  const responses = {
    consent: await consentPOST(participantRequest('/api/consent', session, consentBody(session, studyId))),
    greeting: await greetingPOST(participantRequest('/api/greeting', session, {})),
    interview: await interviewPOST(participantRequest('/api/interview', session, interviewBody)),
    save: await savePOST(participantRequest('/api/interviews/save', session, saveBody(studyId))),
  };
  const out: Record<string, { status: number; body: unknown }> = {};
  for (const [route, response] of Object.entries(responses)) {
    expect(response.headers.get('cache-control'), route).toBe('no-store');
    out[route] = { status: response.status, body: await response.json() };
  }
  return out;
}

describe('participant routes against the real WorkspaceStore (RT-06, ST-02/03, JOB-01/02, OPS-01)', () => {
  it('JOB-01/02, ST-02/03: link, exchange, consent, greeting, interview and save commit one interview with its initial job; a replay is a duplicate', async () => {
    expect(DEFAULT_MODEL_BY_PROVIDER.openai).not.toBe(STUDY_MODEL);
    const study = await createStudy({ aiProvider: 'openai', aiModel: STUDY_MODEL });

    const minted = await mintLink(study.id);
    expect(minted.status).toBe(200);
    const { token: code, url } = await minted.json() as { token: string; url: string };
    expect(url).toBe(`${ORIGIN}/p/${code}`);
    // Only the code's digest is stored.
    expect(await sql('SELECT id FROM participant_links')).toEqual([{ id: await sha256Hex(code) }]);

    const { response: exchanged, session } = await exchange(code);
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get('cache-control')).toBe('no-store');
    expect(session).not.toBeNull();

    const consent = await consentPOST(participantRequest('/api/consent', session!, consentBody(session!, study.id)));
    expect(consent.status).toBe(200);
    await expect(consent.json()).resolves.toEqual({ success: true, preview: false, acceptedAt: T0 });

    const greeting = await greetingPOST(participantRequest('/api/greeting', session!, {}));
    expect(greeting.status).toBe(200);
    await expect(greeting.json()).resolves.toEqual({ greeting: 'A synthetic greeting.' });
    const turn = await interviewPOST(participantRequest('/api/interview', session!, interviewBody));
    expect(turn.status).toBe(200);
    expect(providerFactory).toHaveBeenCalledTimes(2);
    for (const [config] of providerFactory.mock.calls) {
      expect(config).toMatchObject({ id: study.id, aiProvider: 'openai', aiModel: STUDY_MODEL });
    }

    const saved = await savePOST(participantRequest('/api/interviews/save', session!, saveBody(study.id)));
    expect(saved.status).toBe(200);
    const interviewId = `session-${session!.handle}`;
    await expect(saved.json()).resolves.toEqual({ success: true, id: interviewId, created: true });

    expect(await sql('SELECT id, study_id, link_id FROM interviews')).toEqual([
      { id: interviewId, study_id: study.id, link_id: await sha256Hex(code) },
    ]);
    const jobs = await sql<{ generation: number; state: string; requested_provider: string; requested_model: string; input_json: string }>(
      'SELECT generation, state, requested_provider, requested_model, input_json FROM analysis_jobs WHERE interview_id = ?',
      interviewId,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ generation: 1, state: 'pending', requested_provider: 'openai', requested_model: STUDY_MODEL });
    expect(JSON.parse(jobs[0].input_json)).toMatchObject({ studyRevision: study.revision, requestedModel: STUDY_MODEL });
    expect(await sql('SELECT interview_count, is_locked FROM studies WHERE id = ?', study.id)).toEqual([
      { interview_count: 1, is_locked: 1 },
    ]);
    expect(await alarmAt()).not.toBeNull();
    // JOB-01: the Queue consumer runs the job; the route never does.
    expect(afterMock).not.toHaveBeenCalled();
    expect(providerFactory).toHaveBeenCalledTimes(2);

    const replay = await savePOST(participantRequest('/api/interviews/save', session!, saveBody(study.id)));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ success: true, id: interviewId, created: false, duplicate: true });
    expect(await sql('SELECT COUNT(*) AS n FROM analysis_jobs')).toEqual([{ n: 1 }]);
  });

  it('OPS-01: draining refuses new collection and link creation but lets a started session continue; frozen refuses the session', async () => {
    const study = await createStudy({ aiProvider: 'openai', aiModel: STUDY_MODEL });
    const { token: code } = await (await mintLink(study.id)).json() as { token: string };
    const { session } = await exchange(code);
    expect((await consentPOST(participantRequest('/api/consent', session!, consentBody(session!, study.id)))).status).toBe(200);

    await setMaintenance('draining');
    const { response: refusedEntry } = await exchange(code);
    expect(refusedEntry.status).toBe(503);
    expect(refusedEntry.headers.get('set-cookie')).toBeNull();
    await expect(refusedEntry.json()).resolves.toEqual({
      valid: false,
      error: 'New interviews cannot start right now. Please try again later.',
      retryable: true,
      reason: 'maintenance',
    });
    const refusedMint = await mintLink(study.id);
    expect(refusedMint.status).toBe(503);
    await expect(refusedMint.json()).resolves.toMatchObject({ retryable: true, reason: 'maintenance' });
    expect((await greetingPOST(participantRequest('/api/greeting', session!, {}))).status).toBe(200);

    await setMaintenance('frozen');
    // The object refuses the session's own link check; each route answers
    // with its held-workspace copy and the public reason.
    const frozen = await heldParticipantResponses(session!, study.id);
    expect(frozen).toEqual({
      consent: {
        status: 503,
        body: { error: 'Consent cannot be recorded right now. Please try again later.', retryable: true, reason: 'maintenance' },
      },
      greeting: {
        status: 503,
        body: { error: 'This interview is paused for maintenance. Please try again later.', retryable: true, reason: 'maintenance' },
      },
      interview: {
        status: 503,
        body: { error: 'This interview is paused for maintenance. Please try again later.', retryable: true, reason: 'maintenance' },
      },
      save: {
        status: 503,
        body: {
          error: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
          retryable: true,
          reason: 'maintenance',
        },
      },
    });
    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(await sql('SELECT COUNT(*) AS n FROM interviews')).toEqual([{ n: 0 }]);
  });

  it('OPS-01: an epoch hold refuses consent, greeting, interview and save as workspace-unavailable; only the save stays retryable', async () => {
    const study = await createStudy({ aiProvider: 'openai', aiModel: STUDY_MODEL });
    const { token: code } = await (await mintLink(study.id)).json() as { token: string };
    const { session } = await exchange(code);
    expect(session).not.toBeNull();

    // A restored object whose activated epoch no longer matches the deployment.
    await sql('UPDATE workspace_meta SET activated_epoch = ?', 'ep_ffffffffffffffffffffffffffffffff');
    const held = await heldParticipantResponses(session!, study.id);

    expect(held).toEqual({
      consent: {
        status: 503,
        body: {
          error: 'Consent cannot be recorded because this study is unavailable. Please contact the researcher.',
          retryable: false,
          reason: 'workspace-unavailable',
        },
      },
      greeting: {
        status: 503,
        body: {
          error: 'This interview is unavailable right now. Please contact the researcher.',
          retryable: false,
          reason: 'workspace-unavailable',
        },
      },
      interview: {
        status: 503,
        body: {
          error: 'This interview is unavailable right now. Please contact the researcher.',
          retryable: false,
          reason: 'workspace-unavailable',
        },
      },
      // The browser keeps the transcript and retries the save.
      save: {
        status: 503,
        body: {
          error: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
          retryable: true,
          reason: 'workspace-unavailable',
        },
      },
    });
    expect(JSON.stringify(held)).not.toContain('epoch');
    expect(providerFactory).not.toHaveBeenCalled();
    expect(await sql('SELECT COUNT(*) AS n FROM interviews')).toEqual([{ n: 0 }]);
    expect(await sql('SELECT COUNT(*) AS n FROM consents')).toEqual([{ n: 0 }]);
  });

  it('RT-09, ST-03: a revoked link refuses the session, including a replay of its committed save', async () => {
    const study = await createStudy({ aiProvider: 'openai', aiModel: STUDY_MODEL });
    const { token: code } = await (await mintLink(study.id)).json() as { token: string };
    const { session } = await exchange(code);
    await consentPOST(participantRequest('/api/consent', session!, consentBody(session!, study.id)));
    expect((await savePOST(participantRequest('/api/interviews/save', session!, saveBody(study.id)))).status).toBe(200);

    const revoked = await linksDELETE(
      await researcherRequest(`${ORIGIN}/api/studies/${study.id}/participant-links`, 'DELETE', { linkId: await sha256Hex(code) }),
      { params: Promise.resolve({ id: study.id }) },
    );
    expect(revoked.status).toBe(200);

    const replay = await savePOST(participantRequest('/api/interviews/save', session!, saveBody(study.id)));
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toEqual({ error: 'Participant link is no longer active.' });
    expect((await exchange(code)).response.status).toBe(403);
    expect(await sql('SELECT COUNT(*) AS n FROM analysis_jobs')).toEqual([{ n: 1 }]);
  });
});

// RT-11 / D9: the transport disclosed at consent binds every later provider
// call that carries this participant's content. Only the Worker env changes
// between the two routes; the object and the routes are real.
const GATEWAY_ENV = {
  AI_TRANSPORT: 'cloudflare-gateway',
  CF_AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  CF_AI_GATEWAY_ID: 'oi-workers-test',
  CF_AI_GATEWAY_TOKEN: 'synthetic-ai-gateway-run-token-0123456789',
};

function useWorkerEnv(extra: Record<string, string>): void {
  for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value);
  const invocation: WorkerInvocation = {
    env: { ...testEnv, ADMIN_PASSWORD, ...extra },
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtime[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

describe('consent binds the provider transport (RT-11, D9)', () => {
  it('a gateway installation discloses the gateway, records it with the consent, the interview and the initial job', async () => {
    useWorkerEnv(GATEWAY_ENV);
    const study = await createStudy({ aiProvider: 'openai', aiModel: STUDY_MODEL });
    const { token: code } = await (await mintLink(study.id)).json() as { token: string };
    const { session } = await exchange(code);
    expect(session?.aiTransport).toBe('cloudflare-gateway');

    // A page rendered for another transport, or an older page that sends none, is refused.
    for (const body of [{ studyId: study.id }, { studyId: study.id, disclosedTransport: 'direct' }]) {
      const stale = await consentPOST(participantRequest('/api/consent', session!, body));
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({ code: 'DISCLOSURE_CHANGED' });
    }
    expect(await sql('SELECT COUNT(*) AS n FROM consents')).toEqual([{ n: 0 }]);

    expect((await consentPOST(participantRequest('/api/consent', session!, consentBody(session!, study.id)))).status).toBe(200);
    const [consentRow] = await sql<{ record_json: string }>('SELECT record_json FROM consents');
    expect(JSON.parse(consentRow.record_json)).toMatchObject({ disclosedTransport: 'cloudflare-gateway' });

    expect((await greetingPOST(participantRequest('/api/greeting', session!, {}))).status).toBe(200);
    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(providerFactory.mock.calls[0][1]).toMatchObject({
      route: { transport: 'cloudflare-gateway', accountId: GATEWAY_ENV.CF_AI_GATEWAY_ACCOUNT_ID, gatewayId: GATEWAY_ENV.CF_AI_GATEWAY_ID },
    });

    expect((await savePOST(participantRequest('/api/interviews/save', session!, saveBody(study.id)))).status).toBe(200);
    const interviewId = `session-${session!.handle}`;
    const [record] = await sql<{ record_json: string }>('SELECT record_json FROM interviews WHERE id = ?', interviewId);
    expect(JSON.parse(record.record_json)).toMatchObject({ consentTransport: 'cloudflare-gateway' });
    const [job] = await sql<{ input_json: string }>('SELECT input_json FROM analysis_jobs WHERE interview_id = ?', interviewId);
    expect(JSON.parse(job.input_json)).toMatchObject({ disclosedTransport: 'cloudflare-gateway', requestedModel: STUDY_MODEL });
  });

  it('switch drill: a direct-consented session is refused on the gateway before admission and provider, and can still save', async () => {
    const study = await createStudy({ aiProvider: 'openai', aiModel: STUDY_MODEL });
    const { token: code } = await (await mintLink(study.id)).json() as { token: string };
    const { session } = await exchange(code);
    expect(session?.aiTransport).toBe('direct');
    expect((await consentPOST(participantRequest('/api/consent', session!, consentBody(session!, study.id)))).status).toBe(200);
    const [directConsent] = await sql<{ record_json: string }>('SELECT record_json FROM consents');
    expect(JSON.parse(directConsent.record_json)).not.toHaveProperty('disclosedTransport');

    useWorkerEnv(GATEWAY_ENV);
    const budgetBefore = await sql('SELECT COUNT(*) AS n FROM budget_members');
    for (const [call, body] of [[greetingPOST, {}], [interviewPOST, interviewBody]] as const) {
      const refused = await call(participantRequest(call === greetingPOST ? '/api/greeting' : '/api/interview', session!, body));
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toMatchObject({ code: 'TRANSPORT_NOT_DISCLOSED' });
    }
    expect(providerFactory).not.toHaveBeenCalled();
    expect(await sql('SELECT COUNT(*) AS n FROM budget_members')).toEqual(budgetBefore);

    // The same session cannot re-consent under the new notice: it reopens the link.
    const replay = await consentPOST(participantRequest('/api/consent', session!, { studyId: study.id, disclosedTransport: 'cloudflare-gateway' }));
    expect(replay.status).toBe(409);

    // Saving makes no provider call, so the transcript is kept; its job stays direct-only.
    expect((await savePOST(participantRequest('/api/interviews/save', session!, saveBody(study.id)))).status).toBe(200);
    const [job] = await sql<{ input_json: string }>('SELECT input_json FROM analysis_jobs');
    expect(JSON.parse(job.input_json)).not.toHaveProperty('disclosedTransport');

    // A new session on the gateway is disclosed the gateway.
    const { session: fresh } = await exchange(code);
    expect(fresh?.aiTransport).toBe('cloudflare-gateway');
  });
});
