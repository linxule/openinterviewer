// Starts the prebuilt production Worker in local workerd and guards outbound
// network access: only explicitly registered synthetic fixtures answer; any
// other destination (including *.upstash.io) is recorded and refused. Before
// wrangler is loaded it removes credential-like variables from this process's
// environment (VERIFY-01), so no inherited provider or cloud credential can
// reach wrangler, the runtime or a fixture; the Worker receives only the
// synthetic bindings passed below.
import type { createTestHarness as CreateTestHarness } from 'wrangler';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { CREDENTIAL_NAME, credentialNames, scrubCredentials, scrubNotice } from '../../scripts/cloudflare/credential-env.mjs';

const ROOT = path.resolve(__dirname, '../..');
export const ARTIFACT_WORKER_DIR = path.join(ROOT, 'dist/cloudflare/artifact/worker');
export const ARTIFACT_CONFIG = path.join(ROOT, 'cloudflare/test/wrangler.artifact.jsonc');

export const SYNTHETIC_SECRETS = {
  ADMIN_PASSWORD: 'synthetic-admin-password-0001',
  SESSION_SECRET: 'synthetic-session-secret-00000000000000000001',
  PARTICIPANT_TOKEN_SECRET: 'synthetic-participant-secret-000000000000000001',
  RATE_LIMIT_SALT: 'synthetic-rate-limit-salt-00000000000000000001',
  OPENAI_API_KEY: 'sk-synthetic-artifact-openai',
};

// VERIFY-01: one rule for every launcher (scripts/cloudflare/credential-env.mjs).
export { CREDENTIAL_NAME };

/** Names (never values) of credential-like variables in `environment`. */
export function inheritedCredentialNames(environment: Record<string, string | undefined> = process.env): string[] {
  return credentialNames(environment);
}

/**
 * Removes credential-like variables from this process's environment and
 * prints their names (never values). Returns the names removed.
 */
export function scrubInheritedCredentials(): string[] {
  const removed = scrubCredentials(process.env);
  if (removed.length > 0) console.warn(scrubNotice('artifact harness', removed));
  return removed;
}

export type OutboundCall = { url: string; method: string; host: string };
type FixtureHandler = (request: Request) => Promise<Response> | Response;

export type ArtifactHarness = {
  harness: Awaited<ReturnType<typeof CreateTestHarness>>;
  url: string;
  outbound: OutboundCall[];
  refused: OutboundCall[];
  setFixture(host: string, handler: FixtureHandler | null): void;
  close(): Promise<void>;
};

// One process-wide outbound guard shared by every harness in this file.
const realFetch = globalThis.fetch;
const harnessOrigins = new Set<string>();
const fixtures = new Map<string, FixtureHandler>();
const outboundLog: OutboundCall[] = [];
const refusedLog: OutboundCall[] = [];
let guardInstalled = false;

function installGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (harnessOrigins.has(url.origin)) return realFetch(request);
    const call = { url: `${url.origin}${url.pathname}`, method: request.method, host: url.host };
    const handler = fixtures.get(url.host);
    if (!handler) {
      refusedLog.push(call);
      return new Response('outbound request refused by artifact test guard', { status: 599 });
    }
    outboundLog.push(call);
    return handler(request);
  }) as typeof fetch;
}

export type StartOptions = {
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  /** Default synthetic secrets to leave out (applied before `secrets`), e.g. the OpenAI key. */
  omitSecrets?: ReadonlyArray<keyof typeof SYNTHETIC_SECRETS>;
};

export async function startArtifact(overrides: StartOptions = {}): Promise<ArtifactHarness> {
  // Before wrangler is loaded: nothing it reads at import or start time can see a credential.
  scrubInheritedCredentials();
  if (!existsSync(ARTIFACT_WORKER_DIR)) {
    throw new Error('Build the artifact first: npm run build:cloudflare');
  }
  const { createTestHarness } = await import('wrangler');
  installGuard();
  const base: Record<string, string> = { ...SYNTHETIC_SECRETS };
  for (const name of overrides.omitSecrets ?? []) delete base[name];
  const harness = await createTestHarness({
    workers: [{
      configPath: ARTIFACT_CONFIG,
      prebuiltWorkerDir: ARTIFACT_WORKER_DIR,
      vars: overrides.vars,
      secrets: { ...base, ...overrides.secrets },
    }],
  });
  const listened = await harness.listen();
  const url = String(listened.url);
  const origin = new URL(url).origin;
  harnessOrigins.add(origin);
  return {
    harness,
    url,
    outbound: outboundLog,
    refused: refusedLog,
    setFixture(host, handler) {
      if (handler) fixtures.set(host, handler);
      else fixtures.delete(host);
    },
    async close() {
      harnessOrigins.delete(origin);
      await harness.close();
    },
  };
}

export function cookieFrom(response: Response, name: string): string | null {
  const values = response.headers.getSetCookie?.() ?? [];
  for (const value of values) {
    const [pair] = value.split(';');
    const [key, ...rest] = pair.split('=');
    if (key.trim() === name) return `${key.trim()}=${rest.join('=')}`;
  }
  return null;
}
