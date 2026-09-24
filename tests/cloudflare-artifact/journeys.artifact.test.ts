// Production-artifact API journeys (VERIFY-02/03, JOB-01/02, ST-08, RT-05, RT-11).
// Each journey runs the prebuilt Worker from dist/cloudflare/artifact through
// wrangler's createTestHarness: real OpenNext handlers, the real WorkspaceStore
// on local SQLite, its real alarm and the local Queue consumer. The test acts
// only as the browser clients in src/services do; background analysis runs
// with no client action. Outbound Worker requests reach this Node process,
// where synthetic fixtures answer in each provider's wire format and every
// other destination is refused and recorded (harness.ts). Every provider runs
// once direct and once through the Cloudflare AI Gateway route, selected only
// by runtime bindings: the artifact is built with AI_TRANSPORT=direct.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARTIFACT_WORKER_DIR,
  cookieFrom,
  startArtifact,
  SYNTHETIC_SECRETS,
  type ArtifactHarness,
} from './harness';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
} from '../../src/types';

type Provider = 'openai' | 'claude' | 'gemini' | 'openrouter';
type Transport = 'direct' | 'cloudflare-gateway';
type Operation = 'greeting' | 'interview' | 'synthesis' | 'unclassified';
type ProviderCall = {
  operation: Operation;
  method: string;
  path: string;
  model: unknown;
  keyPresented: boolean;
  /** Every cf-aig-* request header, by lower-case name. */
  cfAig: Record<string, string>;
  body: string;
};

type ProviderSpec = {
  host: string;
  path: string;
  /** The native path below the gateway's per-provider slug (RT-11). */
  gatewayPath: string;
  keyName: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'GEMINI_API_KEY' | 'OPENROUTER_API_KEY';
  key: string;
  defaultModel: string;
  /** The study's explicit model; deliberately not the provider default. */
  studyModel: string;
  /** The dated snapshot the fixture reports having served. */
  servedModel: string;
  routedProvider?: string;
};

// Endpoints the locked SDKs call (src/lib/providers/*): OpenAI Responses,
// Anthropic Messages, Gemini Interactions, OpenRouter chat completions.
const PROVIDERS: Readonly<Record<Provider, ProviderSpec>> = {
  openai: {
    host: 'api.openai.com',
    path: '/v1/responses',
    gatewayPath: '/openai/responses',
    keyName: 'OPENAI_API_KEY',
    key: SYNTHETIC_SECRETS.OPENAI_API_KEY,
    defaultModel: DEFAULT_OPENAI_MODEL,
    studyModel: 'gpt-5.6-sol',
    servedModel: 'gpt-5.6-sol-2026-09-01',
  },
  claude: {
    host: 'api.anthropic.com',
    path: '/v1/messages',
    gatewayPath: '/anthropic/v1/messages',
    keyName: 'ANTHROPIC_API_KEY',
    key: 'sk-ant-synthetic-artifact-claude-0001',
    defaultModel: DEFAULT_CLAUDE_MODEL,
    studyModel: 'claude-opus-5',
    servedModel: 'claude-opus-5-20260901',
  },
  gemini: {
    host: 'generativelanguage.googleapis.com',
    path: '/v1beta/interactions',
    gatewayPath: '/google-ai-studio/v1beta/interactions',
    keyName: 'GEMINI_API_KEY',
    key: 'synthetic-artifact-gemini-key-0001',
    defaultModel: DEFAULT_GEMINI_MODEL,
    studyModel: 'gemini-2.5-pro',
    servedModel: 'gemini-2.5-pro-002',
  },
  openrouter: {
    host: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    gatewayPath: '/openrouter/chat/completions',
    keyName: 'OPENROUTER_API_KEY',
    key: 'sk-or-synthetic-artifact-openrouter-0001',
    defaultModel: DEFAULT_OPENROUTER_MODEL,
    studyModel: 'anthropic/claude-sonnet-5',
    servedModel: 'anthropic/claude-sonnet-5-20260901',
    routedProvider: 'Anthropic',
  },
};

// RT-11: synthetic gateway bindings. The account ID matches the credential-like
// name rule, so launchers strip it from their own environment; the Worker
// receives it only as the var passed here.
const GATEWAY_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const GATEWAY_ID = 'oi-artifact-journey';
const GATEWAY_TOKEN = 'synthetic-artifact-ai-gateway-run-token-0001';
const GATEWAY_HOST = 'gateway.ai.cloudflare.com';

/** Written out here, not imported, so the test does not share the Worker's constant. */
const EXPECTED_CF_AIG_HEADERS = {
  'cf-aig-authorization': `Bearer ${GATEWAY_TOKEN}`,
  'cf-aig-collect-log': 'false',
  'cf-aig-collect-log-payload': 'false',
  'cf-aig-skip-cache': 'true',
  'cf-aig-max-attempts': '1',
  'cf-aig-no-wholesale': 'true',
};

function providerRoute(provider: Provider, transport: Transport): { host: string; path: string } {
  const spec = PROVIDERS[provider];
  return transport === 'direct'
    ? { host: spec.host, path: spec.path }
    : { host: GATEWAY_HOST, path: `/v1/${GATEWAY_ACCOUNT_ID}/${GATEWAY_ID}${spec.gatewayPath}` };
}

function transportBindings(transport: Transport): { vars: Record<string, string>; secrets: Record<string, string> } {
  return transport === 'direct'
    ? { vars: {}, secrets: {} }
    : {
      vars: { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: GATEWAY_ACCOUNT_ID, CF_AI_GATEWAY_ID: GATEWAY_ID },
      secrets: { CF_AI_GATEWAY_TOKEN: GATEWAY_TOKEN },
    };
}

// ---------- Synthetic research content ----------

const GREETING = 'Tell me how you return to a saved research document.';
const ANSWER = 'I keep a short project note so I remember why I saved the document.';
const CLOSING = 'Thank you. That completes our conversation.';
const INSIGHT = 'Project notes preserve the reason for saving.';
const SYNTHESIS = {
  statedPreferences: ['A short project note'],
  revealedPreferences: ['Context before rereading'],
  themes: [{ theme: 'Remembering context', frequency: 1, evidenceRefs: [{ quote: ANSWER, turnIndex: 1 }] }],
  contradictions: [],
  keyInsights: [INSIGHT],
  bottomLine: INSIGHT,
};
const INTERVIEW_TURN = {
  message: CLOSING,
  questionAddressed: 0,
  phaseTransition: 'wrap-up',
  profileUpdates: [],
  shouldConclude: true,
};
const BEHAVIOR = { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] };

// ---------- Provider fixtures (wire format per adapter) ----------

function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** The structured-output schema each adapter sends, where it sends it. */
function schemaProperties(provider: Provider, body: unknown): Record<string, unknown> | null {
  const schema = provider === 'openai' ? at(body, 'text', 'format', 'schema')
    : provider === 'claude' ? at(body, 'output_config', 'format', 'schema')
      : provider === 'gemini' ? at(body, 'response_format', 'schema')
        : at(body, 'response_format', 'json_schema', 'schema');
  const properties = at(schema, 'properties');
  return properties && typeof properties === 'object' ? properties as Record<string, unknown> : null;
}

function classify(provider: Provider, body: unknown, raw: string): Operation {
  if (!body || typeof body !== 'object') return 'unclassified';
  const properties = schemaProperties(provider, body);
  if (properties === null) {
    // A greeting is plain text: no structured-output schema anywhere in the request.
    return /"(?:statedPreferences|shouldConclude|commonThemes)"/.test(raw) ? 'unclassified' : 'greeting';
  }
  if ('statedPreferences' in properties) return 'synthesis';
  if ('shouldConclude' in properties) return 'interview';
  return 'unclassified';
}

function responseBody(provider: Provider, text: string): unknown {
  const spec = PROVIDERS[provider];
  switch (provider) {
    case 'openai':
      return {
        id: 'resp_synthetic', object: 'response', created_at: 1, status: 'completed', model: spec.servedModel,
        output: [{ type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      };
    case 'claude':
      return {
        id: 'msg_synthetic', type: 'message', role: 'assistant', model: spec.servedModel,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    case 'gemini':
      return {
        id: 'interaction_synthetic', model: spec.servedModel, status: 'completed', role: 'model',
        created: '2026-09-23T00:00:00Z', updated: '2026-09-23T00:00:00Z',
        steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
      };
    case 'openrouter':
      return {
        id: 'gen_synthetic', object: 'chat.completion', created: 1, model: spec.servedModel, system_fingerprint: null,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
        openrouter_metadata: {
          attempt: 1,
          attempts: [{ model: spec.studyModel, provider: spec.routedProvider, status: 200 }],
          endpoints: { available: [], total: 0 },
          is_byok: false,
          region: null,
          requested: spec.studyModel,
          strategy: 'direct',
          summary: 'synthetic',
        },
      };
  }
}

/**
 * Answers greeting, interview turn and synthesis in the provider's shape at the
 * transport's route; records every call.
 */
function installProviderFixture(app: ArtifactHarness, provider: Provider, transport: Transport): ProviderCall[] {
  const spec = PROVIDERS[provider];
  const route = providerRoute(provider, transport);
  const calls: ProviderCall[] = [];
  app.setFixture(route.host, async (request) => {
    const url = new URL(request.url);
    const raw = await request.text();
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const operation = classify(provider, body, raw);
    const presented = [...request.headers.values()].some((value) => value.includes(spec.key))
      || url.search.includes(spec.key);
    const cfAig: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      if (name.toLowerCase().startsWith('cf-aig-')) cfAig[name.toLowerCase()] = value;
    });
    calls.push({ operation, method: request.method, path: url.pathname, model: at(body, 'model'), keyPresented: presented, cfAig, body: raw });
    if (request.method !== 'POST' || url.pathname !== route.path || operation === 'unclassified') {
      return Response.json({ error: { message: 'unexpected synthetic request', type: 'invalid_request_error' } }, { status: 400 });
    }
    const text = operation === 'greeting' ? GREETING : JSON.stringify(operation === 'interview' ? INTERVIEW_TURN : SYNTHESIS);
    return Response.json(responseBody(provider, text));
  });
  return calls;
}

function countOf(calls: ProviderCall[], operation: Operation): number {
  return calls.filter((call) => call.operation === operation).length;
}

// ---------- Browser-equivalent API clients ----------

const PARTICIPANT_SESSION_HEADER = 'X-OpenInterviewer-Participant-Session';

function send(app: ArtifactHarness, pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(pathname, app.url), { redirect: 'manual', ...init });
}

function sendJson(app: ArtifactHarness, pathname: string, method: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return send(app, pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function signIn(app: ArtifactHarness): Promise<string> {
  const response = await sendJson(app, '/api/auth', 'POST', { password: SYNTHETIC_SECRETS.ADMIN_PASSWORD });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  const cookie = cookieFrom(response, 'research-auth');
  expect(cookie).toBeTruthy();
  return cookie!;
}

function studyConfig(provider: Provider, model: string): Record<string, unknown> {
  return {
    name: `Synthetic ${provider} artifact study`,
    description: 'Synthetic fixture study for the production-artifact journeys.',
    researchQuestion: 'How do people resume research after a break?',
    coreQuestions: ['How do you return to a saved document?'],
    topicAreas: ['resuming work'],
    profileSchema: [],
    aiBehavior: 'standard',
    aiProvider: provider,
    aiModel: model,
    consentText: 'This synthetic study records your answers for research purposes.',
  };
}

/** StorageService.saveStudy (create): Idempotency-Key plus config without server-owned fields. */
async function createStudy(app: ArtifactHarness, researcher: string, provider: Provider, model: string): Promise<string> {
  const response = await sendJson(app, '/api/studies', 'POST', { config: studyConfig(provider, model) }, {
    Cookie: researcher,
    'Idempotency-Key': randomUUID(),
  });
  expect(response.status).toBe(200);
  const body = await readJson(response) as { study: { id: string; config: { aiProvider: string; aiModel: string } } };
  expect(body.study.config).toMatchObject({ aiProvider: provider, aiModel: model });
  return body.study.id;
}

async function mintLink(app: ArtifactHarness, researcher: string, studyId: string): Promise<string> {
  const response = await sendJson(app, '/api/generate-link', 'POST', { studyConfig: { id: studyId } }, { Cookie: researcher });
  expect(response.status).toBe(200);
  const body = await readJson(response) as { token: string; url: string };
  expect(body.url).toBe(`https://workflow.example.test/p/${body.token}`);
  return body.token;
}

/** `aiTransport` is what the consent page discloses and echoes back (D9). */
type ParticipantSession = { cookie: string; handle: string; aiTransport: string };

async function exchange(app: ArtifactHarness, code: string): Promise<ParticipantSession> {
  const response = await send(app, `/api/generate-link?token=${encodeURIComponent(code)}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const cookies = response.headers.getSetCookie();
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatch(/HttpOnly/i);
  const body = await readJson(response) as { valid: boolean; data: { sessionHandle: string; aiTransport: string } };
  expect(body.valid).toBe(true);
  return { cookie: cookies[0].split(';')[0], handle: body.data.sessionHandle, aiTransport: body.data.aiTransport };
}

/** buildParticipantOrPreviewHeaders: the session selector accompanies the HttpOnly cookie. */
function participantPost(app: ArtifactHarness, session: ParticipantSession, pathname: string, body: unknown): Promise<Response> {
  return sendJson(app, pathname, 'POST', body, { Cookie: session.cookie, [PARTICIPANT_SESSION_HEADER]: session.handle });
}

async function consent(app: ArtifactHarness, session: ParticipantSession, studyId: string): Promise<void> {
  const response = await participantPost(app, session, '/api/consent', { studyId, disclosedTransport: session.aiTransport });
  expect(response.status).toBe(200);
  expect(await readJson(response)).toMatchObject({ success: true, preview: false });
}

type Message = { id: string; role: 'ai' | 'user'; content: string; timestamp: number };

async function save(app: ArtifactHarness, session: ParticipantSession, studyId: string, transcript: Message[]): Promise<string> {
  const response = await participantPost(app, session, '/api/interviews/save', {
    id: 'browser-id',
    studyId,
    transcript,
    participantProfile: null,
    behaviorData: BEHAVIOR,
    createdAt: transcript[0].timestamp,
    completedAt: Date.now(),
    status: 'completed',
  });
  expect(response.status).toBe(200);
  const interviewId = `session-${session.handle}`;
  expect(await readJson(response)).toEqual({ success: true, id: interviewId, created: true });
  return interviewId;
}

function analyzePath(studyId: string, interviewId: string): string {
  return `/api/interviews/${encodeURIComponent(interviewId)}/analyze?studyId=${encodeURIComponent(studyId)}`;
}

type AnalysisBody = { status: string; generation: number; phase?: string; failureKind?: string; recoveryRequired?: boolean };

/**
 * getInterviewAnalysisStatus: a read-only GET (no body, no key). Polls until
 * the durable projection leaves pending; never POSTs, so only the alarm and
 * the Queue consumer can make progress.
 */
async function awaitAnalysis(app: ArtifactHarness, researcher: string, studyId: string, interviewId: string): Promise<AnalysisBody> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await send(app, analyzePath(studyId, interviewId), { headers: { Cookie: researcher }, cache: 'no-store' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await readJson(response) as AnalysisBody;
    if (body.status !== 'pending') return body;
    expect(body.generation).toBe(1);
    expect(['queued', 'running']).toContain(body.phase);
    if (Date.now() > deadline) throw new Error('analysis still pending after 60 s');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function exportZip(app: ArtifactHarness, researcher: string): Promise<{ zip: JSZip; bytes: number }> {
  const response = await send(app, '/api/interviews/export', { headers: { Cookie: researcher } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/zip');
  expect(response.headers.get('cache-control')).toContain('no-store');
  const buffer = await response.arrayBuffer();
  return { zip: await JSZip.loadAsync(buffer), bytes: buffer.byteLength };
}

function interviewEntries(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((name) => /^\d{3}_\d{4}-\d{2}-\d{2}_[A-Za-z0-9_-]{1,8}\.json$/.test(name));
}

function logText(app: ArtifactHarness): string {
  return app.harness.getLogs().map((log) => log.message).join('\n');
}

// ---------- 1. One full journey per provider and transport ----------

const JOURNEYS: ReadonlyArray<[Provider, Transport]> = (['direct', 'cloudflare-gateway'] as const)
  .flatMap((transport) => (Object.keys(PROVIDERS) as Provider[]).map((provider): [Provider, Transport] => [provider, transport]));

describe.each(JOURNEYS)('%s journey, %s transport, through the production artifact (VERIFY-02/03, JOB-01/02, ST-08, RT-05, RT-11)', (provider, transport) => {
  const spec = PROVIDERS[provider];
  const route = providerRoute(provider, transport);
  const bindings = transportBindings(transport);
  const viaGateway = transport === 'cloudflare-gateway';
  let app: ArtifactHarness;
  let calls: ProviderCall[];
  let researcher: string;
  let studyId: string;
  let interviewId: string;
  let outboundStart: number;

  beforeAll(async () => {
    app = await startArtifact({
      vars: { AI_PROVIDER: provider, ...bindings.vars },
      omitSecrets: ['OPENAI_API_KEY'],
      secrets: { [spec.keyName]: spec.key, ...bindings.secrets },
    });
    calls = installProviderFixture(app, provider, transport);
    outboundStart = app.outbound.length;
  });

  afterAll(async () => {
    app?.setFixture(route.host, null);
    await app?.close();
  });

  it(`VERIFY-03/JOB-01 ${provider} (${transport}): a participant saves and analysis completes in the background with exactly one synthesis request`, async () => {
    expect(spec.studyModel).not.toBe(spec.defaultModel);
    const readiness = await readJson(await send(app, '/api/config/readiness'));
    expect(readiness).toMatchObject({ ready: true, analysisExecution: 'queued-v2' });
    // RT-11: the transport comes from the runtime bindings, not the build-time AI_TRANSPORT=direct.
    expect(await readJson(await send(app, '/api/config/mode'))).toMatchObject({ aiTransport: transport, ready: true });

    researcher = await signIn(app);
    // RT-05: the Worker holds only this provider's key.
    const status = await send(app, '/api/config/status', { headers: { Cookie: researcher } });
    expect(status.status).toBe(200);
    expect(await readJson(status)).toMatchObject({
      storage: 'workspace-do',
      aiTransport: transport,
      hasOpenAiKey: provider === 'openai',
      hasAnthropicKey: provider === 'claude',
      hasGeminiKey: provider === 'gemini',
      hasOpenRouterKey: provider === 'openrouter',
    });

    studyId = await createStudy(app, researcher, provider, spec.studyModel);
    const code = await mintLink(app, researcher, studyId);
    const session = await exchange(app, code);
    // D9: the link exchange discloses the transport the consent page shows and echoes.
    expect(session.aiTransport).toBe(transport);
    await consent(app, session, studyId);

    const greeting = await participantPost(app, session, '/api/greeting', {});
    expect(greeting.status).toBe(200);
    expect(await readJson(greeting)).toEqual({ greeting: GREETING });

    const t0 = Date.now() - 60_000;
    const history: Message[] = [
      { id: 'm1', role: 'ai', content: GREETING, timestamp: t0 },
      { id: 'm2', role: 'user', content: ANSWER, timestamp: t0 + 20_000 },
    ];
    const turn = await participantPost(app, session, '/api/interview', {
      history,
      participantProfile: null,
      questionProgress: { questionsAsked: [], total: 1, currentPhase: 'core-questions', isComplete: false },
      currentContext: '',
    });
    expect(turn.status).toBe(200);
    expect(await readJson(turn)).toMatchObject({ message: CLOSING, shouldConclude: true });

    expect(countOf(calls, 'synthesis')).toBe(0);
    interviewId = await save(app, session, studyId, [
      ...history,
      { id: 'm3', role: 'ai', content: CLOSING, timestamp: t0 + 40_000 },
    ]);

    expect(await awaitAnalysis(app, researcher, studyId, interviewId)).toEqual({ status: 'complete', generation: 1 });

    // Exactly one call per operation, each at the transport's route for this
    // provider with the study's explicit model and the Worker's key for this
    // provider. On the gateway every call carries exactly the six cf-aig-*
    // headers (RT-11); direct calls carry none.
    expect(calls.map((call) => call.operation).sort()).toEqual(['greeting', 'interview', 'synthesis']);
    for (const call of calls) {
      expect(call).toMatchObject({ method: 'POST', path: route.path, model: spec.studyModel, keyPresented: true });
      expect(call.cfAig).toEqual(viaGateway ? EXPECTED_CF_AIG_HEADERS : {});
    }
    const synthesisCall = calls.find((call) => call.operation === 'synthesis')!;
    expect(synthesisCall.body).toContain(ANSWER);

    // API-01: an intentional v2 retry of a completed interview reports
    // already-complete and starts no paid call; polling started none either.
    const retry = await sendJson(app, analyzePath(studyId, interviewId), 'POST', { expectedGeneration: 1 }, {
      Cookie: researcher,
      'X-OpenInterviewer-Analysis-Version': '2',
      'Idempotency-Key': randomUUID(),
    });
    expect(retry.status).toBe(200);
    expect(retry.headers.get('cache-control')).toBe('no-store');
    expect(await readJson(retry)).toEqual({ status: 'already-complete', generation: 1 });
    expect(countOf(calls, 'synthesis')).toBe(1);
  });

  it(`JOB-02/RT-05/RT-11 the stored ${provider} (${transport}) interview names the provider, the served model and the transport; no key, token or participant answer reaches the logs`, async () => {
    const response = await send(app, `/api/interviews/${encodeURIComponent(interviewId)}?studyId=${encodeURIComponent(studyId)}`, {
      headers: { Cookie: researcher },
    });
    expect(response.status).toBe(200);
    const { interview } = await readJson(response) as { interview: Record<string, unknown> };
    expect(interview).toMatchObject({
      id: interviewId,
      studyId,
      aiProvider: provider,
      aiModel: spec.servedModel,
      requestedAiModel: spec.studyModel,
      conductedByProvider: provider,
      conductedByModel: spec.studyModel,
      synthesis: SYNTHESIS,
      analysis: { status: 'complete', generation: 1 },
    });
    if (spec.routedProvider) expect(interview.routedProvider).toBe(spec.routedProvider);
    else expect(interview).not.toHaveProperty('routedProvider');
    if (viaGateway) expect(interview.aiTransport).toBe('cloudflare-gateway');
    else expect(interview).not.toHaveProperty('aiTransport');
    expect(interview.analysis).not.toHaveProperty('recoveryRequired', true);

    const logs = logText(app);
    expect(logs).toContain('"event":"analysis.job"');
    expect(logs).not.toContain(spec.key);
    expect(logs).not.toContain(GATEWAY_TOKEN);
    expect(logs).not.toContain(ANSWER);
  });

  it(`ST-08 the researcher export of the ${provider} (${transport}) workspace is a complete archive`, async () => {
    const { zip } = await exportZip(app, researcher);
    const entries = interviewEntries(zip);
    expect(entries).toHaveLength(1);
    const exported = JSON.parse(await zip.file(entries[0])!.async('string')) as Record<string, unknown>;
    expect(exported).toMatchObject({ id: interviewId, aiProvider: provider, aiModel: spec.servedModel, synthesis: SYNTHESIS });
    expect(zip.file(entries[0].replace(/\.json$/, '.md'))).not.toBeNull();
    const summary = (await zip.file('summary.csv')!.async('string')).split('\n').filter(Boolean);
    expect(summary).toHaveLength(2);
    expect(summary[1]).toContain(`"${interviewId}"`);
    expect(summary[1]).toContain(`"${INSIGHT}"`);
    expect(summary[1].endsWith(',"complete"')).toBe(true);
  });

  it(`VERIFY-01/RT-11 the ${provider} (${transport}) journey made no outbound request beyond its route`, () => {
    expect(app.refused).toEqual([]);
    const journeyOutbound = app.outbound.slice(outboundStart);
    expect(journeyOutbound.map((call) => `${call.method} ${call.url}`)).toEqual(
      calls.map(() => `POST https://${route.host}${route.path}`),
    );
    expect(calls).toHaveLength(3);
  });
});

// ---------- 2. A fresh object without WORKSPACE_BOOTSTRAP stays held ----------

describe('fresh workspace object without WORKSPACE_BOOTSTRAP (gap F2, RT-08)', () => {
  let app: ArtifactHarness;

  beforeAll(async () => {
    app = await startArtifact({ vars: { WORKSPACE_BOOTSTRAP: '' } });
  });

  afterAll(async () => {
    await app?.close();
  });

  async function expectUninitialized(): Promise<void> {
    const health = await send(app, '/api/health/ready');
    expect(health.status).toBe(503);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await readJson(health)).toEqual({
      ready: false,
      mode: 'standalone',
      target: 'cloudflare',
      checks: { configuration: true, workspaceStore: false, analysisQueue: true },
    });
    // The health body carries booleans only; the public readiness view names the reason.
    const readiness = await readJson(await send(app, '/api/config/readiness'));
    expect(readiness).toMatchObject({ ready: false });
    expect(readiness.errors).toEqual(['workspace_uninitialized']);
  }

  it('reports not ready with workspace_uninitialized and refuses a researcher write without initializing the object', async () => {
    await expectUninitialized();
    // Sign-in is deliberately available on a held workspace (operators need it).
    const researcher = await signIn(app);
    const create = await sendJson(app, '/api/studies', 'POST', { config: studyConfig('openai', 'gpt-5.6-sol') }, {
      Cookie: researcher,
      'Idempotency-Key': randomUUID(),
    });
    expect(create.status).toBe(503);
    expect(await readJson(create)).toMatchObject({ retryable: false, reason: 'workspace-unavailable' });
    // The refused write did not bootstrap an empty writable workspace.
    await expectUninitialized();
    const list = await send(app, '/api/studies', { headers: { Cookie: researcher } });
    expect(list.status).toBe(503);
    await list.arrayBuffer();
    expect(app.refused).toEqual([]);
  });
});

// ---------- 4. The deployed bundle carries the backpressure wrapper ----------

describe('deployed bundle (ST-08 export memory)', () => {
  it('ST-08 the artifact Worker uses the cloudflare-node-backpressure OpenNext wrapper', () => {
    const bundle = readFileSync(path.join(ARTIFACT_WORKER_DIR, 'worker.js'), 'utf8');
    expect(bundle).toContain('cloudflare-node-backpressure');
  });
});

// ---------- 3 and 5. Operator status and an abandoned export ----------

const OPERATOR_TOKEN = 'synthetic-operator-token-00000000000000000001';

/** Incompressible synthetic text, so the archive is far larger than one read. */
function bulkyTranscript(t0: number): Message[] {
  return Array.from({ length: 88 }, (_, index) => ({
    id: `m${index + 1}`,
    role: index % 2 === 0 ? 'ai' as const : 'user' as const,
    content: randomBytes(3_750).toString('base64url'),
    timestamp: t0 + index * 1_000,
  }));
}

describe('operator status and an abandoned export on one workspace (OPS-01, ST-08, RT-09)', () => {
  const spec = PROVIDERS.openai;
  let app: ArtifactHarness;
  let calls: ProviderCall[];
  let researcher: string;
  const participantSamples: string[] = [];

  beforeAll(async () => {
    app = await startArtifact({ secrets: { OPERATOR_TOKEN } });
    calls = installProviderFixture(app, 'openai', 'direct');
  });

  afterAll(async () => {
    app?.setFixture(spec.host, null);
    await app?.close();
  });

  it('ST-08 a client that reads a little of an export and cancels leaves the Worker serving: a full export and readiness succeed', async () => {
    researcher = await signIn(app);
    const studyId = await createStudy(app, researcher, 'openai', spec.studyModel);
    const code = await mintLink(app, researcher, studyId);
    const interviewIds: string[] = [];
    for (let participant = 0; participant < 3; participant += 1) {
      const session = await exchange(app, code);
      await consent(app, session, studyId);
      const transcript = bulkyTranscript(Date.now() - 600_000);
      participantSamples.push(transcript[1].content.slice(0, 64));
      interviewIds.push(await save(app, session, studyId, transcript));
    }
    for (const interviewId of interviewIds) {
      expect(await awaitAnalysis(app, researcher, studyId, interviewId)).toEqual({ status: 'complete', generation: 1 });
    }
    expect(countOf(calls, 'synthesis')).toBe(3);

    const abandoned = await send(app, '/api/interviews/export', { headers: { Cookie: researcher } });
    expect(abandoned.status).toBe(200);
    const reader = abandoned.body!.getReader();
    let partialBytes = 0;
    while (partialBytes < 32 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      partialBytes += value.byteLength;
    }
    await reader.cancel();
    expect(partialBytes).toBeGreaterThan(0);

    const { zip, bytes } = await exportZip(app, researcher);
    expect(interviewEntries(zip)).toHaveLength(3);
    expect(Object.keys(zip.files).filter((name) => name.endsWith('.md'))).toHaveLength(3);
    const summary = (await zip.file('summary.csv')!.async('string')).split('\n').filter(Boolean);
    expect(summary).toHaveLength(4);
    for (const interviewId of interviewIds) expect(summary.some((row) => row.includes(`"${interviewId}"`))).toBe(true);
    // The abandoned read stopped well inside the archive, not after it.
    expect(bytes).toBeGreaterThan(1024 * 1024);
    expect(partialBytes).toBeLessThan(bytes / 4);

    const health = await send(app, '/api/health/ready');
    expect(health.status).toBe(200);
    expect(await readJson(health)).toMatchObject({ ready: true, checks: { configuration: true, workspaceStore: true, analysisQueue: true } });
    expect(countOf(calls, 'synthesis')).toBe(3);
    expect(app.refused).toEqual([]);
  });

  it('OPS-01 operator status needs the bearer token and a fresh session, and returns a closed body without secrets or research content', async () => {
    const statusPath = '/api/operator/status';
    const withoutToken = await send(app, statusPath, { headers: { Cookie: researcher } });
    expect(withoutToken.status).toBe(401);
    expect(withoutToken.headers.get('cache-control')).toBe('no-store');
    expect(withoutToken.headers.get('www-authenticate')).toBe('Bearer');
    expect(await readJson(withoutToken)).toMatchObject({ code: 'OPERATOR_UNAUTHORIZED' });

    const wrongToken = await send(app, statusPath, { headers: { Cookie: researcher, Authorization: `Bearer ${OPERATOR_TOKEN}x` } });
    expect(wrongToken.status).toBe(401);
    await wrongToken.arrayBuffer();

    const withoutSession = await send(app, statusPath, { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
    expect(withoutSession.status).toBe(401);
    expect(await readJson(withoutSession)).toMatchObject({ code: 'SIGN_IN_REQUIRED' });

    const fresh = await signIn(app);
    const accepted = await send(app, statusPath, { headers: { Cookie: fresh, Authorization: `Bearer ${OPERATOR_TOKEN}` } });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    const text = await accepted.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['alarm', 'counts', 'epoch', 'jobs', 'maintenance', 'schemaVersion', 'status', 'workspaceId']);
    expect(body).toMatchObject({
      status: 'ok',
      workspaceId: 'ws_0000000000000000000000000000a001',
      maintenance: { state: 'open' },
      epoch: { configuredMatches: true },
      jobs: { pending: 0, claimed: 0, started: 0, recoveryRequired: 0, oldestActiveAgeMs: null },
    });
    expect(Object.keys(body.maintenance as object).sort()).toEqual(['state', 'version']);
    expect(Object.keys(body.epoch as object).sort()).toEqual(['activated', 'configuredMatches']);
    expect(Object.keys(body.alarm as object)).toEqual(['scheduledAt']);
    expect(Object.values(body.counts as object).every((value) => Number.isSafeInteger(value))).toBe(true);

    const secrets = [...Object.values(SYNTHETIC_SECRETS), OPERATOR_TOKEN, fresh.split('=')[1], researcher.split('=')[1]];
    for (const secret of secrets) expect(text).not.toContain(secret);
    for (const sample of participantSamples) expect(text).not.toContain(sample);
    expect(app.refused).toEqual([]);
  });
});
