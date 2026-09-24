// Process control and browser-equivalent API clients for the restart lane.
// The test process owns every runner it spawns (each in its own process
// group), the state directory they persist to, and nothing else.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import { FAILED_PREFIX, HELD_PREFIX, READY_PREFIX, SECRETS, STUDY_MODEL } from './synthetic.mjs';

const ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(ROOT, 'tests/cloudflare-restart/runner.mjs');

// ---------- State directory ----------

/** A fresh runner-owned directory: persistence, wrangler scratch, HOME and TMPDIR all live here. */
export function makeStateDir(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `oi-restart-${label}-`));
  mkdirSync(path.join(dir, 'home'));
  mkdirSync(path.join(dir, 'tmp'));
  return dir;
}

export function removeStateDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------- Runner processes ----------

export type Runner = {
  runtime: string;
  pid: number;
  workerUrl: string;
  controlUrl: string;
  child: ChildProcess;
  exited: Promise<void>;
  /** Every process this runner started, found by walking the tree after it was ready. */
  tree: number[];
  output: string[];
  /** Resolves on the runner's next notice for `what`: 'synthesis', 'save-reply', 'save-reply-forwarded' or 'probe-transaction'. */
  held(what: string, timeoutMs: number): Promise<{ what: string; status?: number }>;
};

function descendants(pid: number): number[] {
  let children: number[] = [];
  try {
    children = execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n').filter(Boolean).map(Number);
  } catch {
    children = [];
  }
  return children.flatMap((child) => [child, ...descendants(child)]);
}

/**
 * Allowlisted environment: no inherited credentials, no dotenv loading,
 * no telemetry, and HOME/TMPDIR inside the state directory so every file the
 * runtime writes is removed with it.
 */
function runnerEnv(stateDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(stateDir, 'home'),
    TMPDIR: `${path.join(stateDir, 'tmp')}/`,
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_HIDE_BANNER: 'true',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
    NO_COLOR: '1',
  };
}

export async function startRunner(
  stateDir: string,
  runtime: string,
  options: { holdSynthesis?: boolean; worker?: 'artifact' | 'txprobe' } = {},
): Promise<Runner> {
  const args = [RUNNER, '--state', stateDir, '--runtime', runtime, '--worker', options.worker ?? 'artifact'];
  if (options.holdSynthesis) args.push('--hold-synthesis');
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    // Deliberately no NODE_ENV or anything else inherited.
    env: runnerEnv(stateDir) as NodeJS.ProcessEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  const holds: Array<{ what: string; status?: number }> = [];
  const holdWaiters = new Set<() => void>();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const ready = await new Promise<{ pid: number; workerUrl: string; controlUrl: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runner ${runtime} not ready after 90 s:\n${output.join('')}`)), 90_000);
    let buffered = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output.push(chunk.toString());
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith(READY_PREFIX)) {
          clearTimeout(timer);
          resolve(JSON.parse(line.slice(READY_PREFIX.length)));
        } else if (line.startsWith(FAILED_PREFIX)) {
          clearTimeout(timer);
          reject(new Error(`runner ${runtime} refused to start: ${line.slice(FAILED_PREFIX.length)}`));
        } else if (line.startsWith(HELD_PREFIX)) {
          holds.push(JSON.parse(line.slice(HELD_PREFIX.length)));
          for (const wake of holdWaiters) wake();
        }
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`runner ${runtime} exited before ready (${code ?? signal}):\n${output.join('')}`));
    });
  });
  const held = (what: string, timeoutMs: number) => new Promise<{ what: string; status?: number }>((resolve, reject) => {
    const check = () => {
      const index = holds.findIndex((hold) => hold.what === what);
      if (index === -1) return false;
      const [hold] = holds.splice(index, 1);
      holdWaiters.delete(check);
      clearTimeout(timer);
      resolve(hold);
      return true;
    };
    const timer = setTimeout(() => {
      holdWaiters.delete(check);
      reject(new Error(`runner ${runtime} held no ${what} within ${timeoutMs} ms`));
    }, timeoutMs);
    if (!check()) holdWaiters.add(check);
  });
  return { runtime, ...ready, child, exited, tree: descendants(ready.pid), output, held };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGKILL the runner's whole process group (it was spawned detached, so the
 * group is exactly this runner, wrangler's esbuild service and both workerd
 * processes), then every PID recorded in its tree, then wait until none
 * exists. Nothing runs a shutdown handler.
 */
export async function killRunner(runner: Runner): Promise<number[]> {
  // The group signal goes first so the cut is not delayed by a process walk.
  try {
    process.kill(-runner.pid, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
  const pids = [runner.pid, ...runner.tree];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await runner.exited;
  const deadline = Date.now() + 10_000;
  while (pids.some(alive)) {
    if (Date.now() > deadline) throw new Error(`processes survived SIGKILL: ${pids.filter(alive).join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pids;
}

// ---------- Durable fixture record (<state>/events.jsonl) ----------

export type RunnerEvent = {
  at: number;
  runtime: string;
  pid: number;
  kind: 'ready' | 'outbound' | 'held' | 'refused' | 'log' | 'request' | 'reply-held' | 'reply-forwarded' | 'frozen';
  operation?: string;
  model?: string;
  keyPresented?: boolean;
  method?: string;
  url?: string;
  path?: string;
  status?: number;
  reason?: string;
  processes?: number;
  message?: string;
};

export function readEvents(stateDir: string): RunnerEvent[] {
  const file = path.join(stateDir, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as RunnerEvent);
}

export function synthesisRequests(stateDir: string, runtime?: string): RunnerEvent[] {
  return readEvents(stateDir).filter((event) => event.kind === 'outbound' && event.operation === 'synthesis'
    && (runtime === undefined || event.runtime === runtime));
}

export function jobLogs(stateDir: string, runtime: string): Array<{ at: number; operation?: string; reason?: string }> {
  return readEvents(stateDir)
    .filter((event) => event.kind === 'log' && event.runtime === runtime && event.message?.includes('"event":"analysis.job"'))
    .map((event) => ({ at: event.at, ...(JSON.parse(event.message!.slice(event.message!.indexOf('{'))) as { operation?: string; reason?: string }) }));
}

export async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs: number, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function control(runner: Runner, pathname: string, method = 'POST'): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(pathname, runner.controlUrl), { method });
  return await response.json() as Record<string, unknown>;
}

// ---------- Browser-equivalent API clients (as in journeys.artifact.test.ts) ----------

const PARTICIPANT_SESSION_HEADER = 'X-OpenInterviewer-Participant-Session';
export const GREETING_TEXT = 'Tell me how you return to a saved research document.';
export const ANSWER = 'I keep a short project note so I remember why I saved the document.';
export const CLOSING = 'Thank you. That completes our conversation.';

export function send(base: string, pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(pathname, base), { redirect: 'manual', ...init });
}

export function sendJson(base: string, pathname: string, method: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return send(base, pathname, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function cookieFrom(response: Response, name: string): string | null {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(';');
    const [key, ...rest] = pair.split('=');
    if (key.trim() === name) return `${key.trim()}=${rest.join('=')}`;
  }
  return null;
}

export async function signIn(base: string): Promise<string> {
  const response = await sendJson(base, '/api/auth', 'POST', { password: SECRETS.ADMIN_PASSWORD });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  const cookie = cookieFrom(response, 'research-auth');
  expect(cookie).toBeTruthy();
  return cookie!;
}

export async function createStudy(base: string, researcher: string): Promise<string> {
  const response = await sendJson(base, '/api/studies', 'POST', {
    config: {
      name: 'Synthetic restart-lane study',
      description: 'Synthetic fixture study for the restart lane.',
      researchQuestion: 'How do people resume research after a break?',
      coreQuestions: ['How do you return to a saved document?'],
      topicAreas: ['resuming work'],
      profileSchema: [],
      aiBehavior: 'standard',
      aiProvider: 'openai',
      aiModel: STUDY_MODEL,
      consentText: 'This synthetic study records your answers for research purposes.',
    },
  }, { Cookie: researcher, 'Idempotency-Key': randomUUID() });
  expect(response.status).toBe(200);
  const body = await readJson(response) as { study: { id: string } };
  return body.study.id;
}

export async function mintLink(base: string, researcher: string, studyId: string): Promise<string> {
  const response = await sendJson(base, '/api/generate-link', 'POST', { studyConfig: { id: studyId } }, { Cookie: researcher });
  expect(response.status).toBe(200);
  return (await readJson(response) as { token: string }).token;
}

/** `aiTransport` is what the consent page discloses and echoes back (D9). */
export type ParticipantSession = { cookie: string; handle: string; aiTransport: string };

export async function exchange(base: string, code: string): Promise<ParticipantSession> {
  const response = await send(base, `/api/generate-link?token=${encodeURIComponent(code)}`);
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  expect(cookies).toHaveLength(1);
  const body = await readJson(response) as { valid: boolean; data: { sessionHandle: string; aiTransport: string } };
  expect(body.valid).toBe(true);
  return { cookie: cookies[0].split(';')[0], handle: body.data.sessionHandle, aiTransport: body.data.aiTransport };
}

export function participantPost(base: string, session: ParticipantSession, pathname: string, body: unknown): Promise<Response> {
  return sendJson(base, pathname, 'POST', body, { Cookie: session.cookie, [PARTICIPANT_SESSION_HEADER]: session.handle });
}

type Message = { id: string; role: 'ai' | 'user'; content: string; timestamp: number };
export type SaveBody = Record<string, unknown>;

/**
 * Sign in, create a study, exchange a link, consent, greet and take one
 * interview turn; returns the exact save body the browser would send.
 */
export async function participantReadyToSave(base: string): Promise<{ researcher: string; studyId: string; session: ParticipantSession; body: SaveBody; interviewId: string }> {
  const researcher = await signIn(base);
  const studyId = await createStudy(base, researcher);
  const session = await exchange(base, await mintLink(base, researcher, studyId));
  const consent = await participantPost(base, session, '/api/consent', { studyId, disclosedTransport: session.aiTransport });
  expect(consent.status).toBe(200);
  expect(await readJson(consent)).toMatchObject({ success: true, preview: false });
  const greeting = await participantPost(base, session, '/api/greeting', {});
  expect(greeting.status).toBe(200);
  expect(await readJson(greeting)).toEqual({ greeting: GREETING_TEXT });
  const t0 = Date.now() - 60_000;
  const history: Message[] = [
    { id: 'm1', role: 'ai', content: GREETING_TEXT, timestamp: t0 },
    { id: 'm2', role: 'user', content: ANSWER, timestamp: t0 + 20_000 },
  ];
  const turn = await participantPost(base, session, '/api/interview', {
    history,
    participantProfile: null,
    questionProgress: { questionsAsked: [], total: 1, currentPhase: 'core-questions', isComplete: false },
    currentContext: '',
  });
  expect(turn.status).toBe(200);
  expect(await readJson(turn)).toMatchObject({ message: CLOSING, shouldConclude: true });
  const transcript = [...history, { id: 'm3', role: 'ai' as const, content: CLOSING, timestamp: t0 + 40_000 }];
  const body: SaveBody = {
    id: 'browser-id',
    studyId,
    transcript,
    participantProfile: null,
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    createdAt: t0,
    completedAt: Date.now(),
    status: 'completed',
  };
  return { researcher, studyId, session, body, interviewId: `session-${session.handle}` };
}

export function save(base: string, session: ParticipantSession, body: SaveBody): Promise<Response> {
  return participantPost(base, session, '/api/interviews/save', body);
}

export function analyzePath(studyId: string, interviewId: string): string {
  return `/api/interviews/${encodeURIComponent(interviewId)}/analyze?studyId=${encodeURIComponent(studyId)}`;
}

export type AnalysisBody = { status: string; generation: number; phase?: string; failureKind?: string; recoveryRequired?: boolean };

export async function analysisStatus(base: string, researcher: string, studyId: string, interviewId: string): Promise<AnalysisBody> {
  const response = await send(base, analyzePath(studyId, interviewId), { headers: { Cookie: researcher } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return await readJson(response) as AnalysisBody;
}

export async function getInterview(base: string, researcher: string, studyId: string, interviewId: string): Promise<Record<string, unknown>> {
  const response = await send(base, `/api/interviews/${encodeURIComponent(interviewId)}?studyId=${encodeURIComponent(studyId)}`, {
    headers: { Cookie: researcher },
  });
  expect(response.status).toBe(200);
  return (await readJson(response) as { interview: Record<string, unknown> }).interview;
}

export async function listInterviews(base: string, researcher: string, studyId: string): Promise<Array<Record<string, unknown>>> {
  const response = await send(base, `/api/interviews?studyId=${encodeURIComponent(studyId)}`, { headers: { Cookie: researcher } });
  expect(response.status).toBe(200);
  return (await readJson(response) as { interviews: Array<Record<string, unknown>> }).interviews;
}

export type OperatorStatus = {
  counts: Record<string, number>;
  jobs: { pending: number; claimed: number; started: number; recoveryRequired: number; oldestActiveAgeMs: number | null };
  alarm: { scheduledAt: number | null };
  maintenance: { state: string };
};

/** Operator status needs the bearer token and a researcher session from the last 15 minutes. */
export async function operatorStatus(base: string, researcher: string): Promise<OperatorStatus> {
  const response = await send(base, '/api/operator/status', {
    headers: { Cookie: researcher, Authorization: `Bearer ${SECRETS.OPERATOR_TOKEN}` },
  });
  expect(response.status).toBe(200);
  return await readJson(response) as unknown as OperatorStatus;
}
