// VERIFY-01: the production-artifact launchers (the artifact harness, the
// Cloudflare browser server and the restart runner) remove credential-like
// variables from their own environment before wrangler is loaded, so no
// inherited provider or cloud credential can reach wrangler, workerd or a
// fixture. They share one rule (scripts/cloudflare/credential-env.mjs) and
// print names only, never values. wrangler is replaced by a recording fake
// here, so this file needs no built artifact and starts no runtime.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_NAME as SHARED_RULE } from '../../scripts/cloudflare/credential-env.mjs';
import { READY_PREFIX } from '../cloudflare-restart/synthetic.mjs';
import { CREDENTIAL_NAME, inheritedCredentialNames, startArtifact } from './harness';

const recorded = vi.hoisted(() => ({
  calls: [] as Array<{ options: unknown; environment: Record<string, string | undefined> }>,
}));

vi.mock('wrangler', () => ({
  createTestHarness: async (options: unknown) => {
    recorded.calls.push({ options, environment: { ...process.env } });
    return { listen: async () => ({ url: 'http://127.0.0.1:9/' }), close: async () => {} };
  },
}));

// The harness checks that the artifact exists before loading wrangler; the fake needs none.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (target: import('node:fs').PathLike) => String(target).endsWith('/dist/cloudflare/artifact/worker') || actual.existsSync(target),
  };
});

const ROOT = path.resolve(__dirname, '../..');
const PLANTED = 'OI_HYGIENE_PROBE_API_KEY';
const PLANTED_VALUE = 'sk-hygiene-probe-value-7f3a';
const SECOND = 'OI_HYGIENE_PROBE_TOKEN';
const SECOND_VALUE = 'hygiene-probe-token-value-c41d';

const includes = (text: string, value: string) => text.includes(value);

afterEach(() => {
  delete process.env[PLANTED];
  vi.restoreAllMocks();
});

describe('VERIFY-01 credential-free artifact launchers', () => {
  it('the shared rule matches credential names and nothing ordinary', () => {
    expect(inheritedCredentialNames({
      CLOUDFLARE_API_TOKEN: 'x',
      CLOUDFLARE_ACCOUNT_ID: 'x',
      OPENAI_API_KEY: 'x',
      ADMIN_PASSWORD: 'x',
      SESSION_SECRET: 'x',
      UPSTASH_REDIS_REST_URL: 'x',
      KV_REST_API_URL: 'x',
      VERCEL_OIDC_TOKEN: 'x',
      PATH: 'x',
      HOME: 'x',
      CI: 'true',
      NODE_ENV: 'test',
      TOKENIZER_PATH: 'x',
      REDIS_URL: 'x',
      PLAYWRIGHT_BROWSERS_PATH: 'x',
    })).toEqual([
      'ADMIN_PASSWORD',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'KV_REST_API_URL',
      'OPENAI_API_KEY',
      'SESSION_SECRET',
      'UPSTASH_REDIS_REST_URL',
      'VERCEL_OIDC_TOKEN',
    ]);
  });

  it('every launcher and the release check use the one shared rule, with no private copy', () => {
    expect(CREDENTIAL_NAME).toBe(SHARED_RULE);
    for (const [file, specifier] of [
      ['tests/cloudflare-artifact/harness.ts', '../../scripts/cloudflare/credential-env.mjs'],
      ['tests/e2e-cloudflare/server.mjs', '../../scripts/cloudflare/credential-env.mjs'],
      ['tests/cloudflare-restart/runner.mjs', '../../scripts/cloudflare/credential-env.mjs'],
      ['scripts/cloudflare/check.mjs', './credential-env.mjs'],
    ]) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      expect(text, file).toContain(`from '${specifier}'`);
      expect(text, file).not.toMatch(/API_KEY\|API_TOKEN/);
      // wrangler is loaded only after the environment is scrubbed.
      expect(text, file).not.toMatch(/^import (?!type )[^;]*from 'wrangler';/m);
    }
  });

  it('the artifact harness removes credential-like variables before wrangler starts and hands it none of their values', async () => {
    const inheritedValues = inheritedCredentialNames().map((name) => process.env[name] ?? '').filter((value) => value.length >= 8);
    process.env[PLANTED] = PLANTED_VALUE;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const app = await startArtifact({ vars: { SAMPLE_VAR: 'plain' } });
    await app.close();

    expect(process.env[PLANTED]).toBeUndefined();
    expect(inheritedCredentialNames()).toEqual([]);
    expect(recorded.calls).toHaveLength(1);
    const [{ options, environment }] = recorded.calls;
    expect(inheritedCredentialNames(environment)).toEqual([]);
    const passed = `${JSON.stringify(options)}\n${JSON.stringify(environment)}`;
    for (const value of [PLANTED_VALUE, ...inheritedValues]) {
      expect(includes(passed, value), 'a scrubbed value reached wrangler').toBe(false);
    }
    // The Worker still receives its explicit synthetic bindings.
    expect(JSON.stringify(options)).toContain('sk-synthetic-artifact-openai');
    const printed = warn.mock.calls.flat().join('\n');
    expect(printed).toContain(PLANTED);
    for (const value of [PLANTED_VALUE, ...inheritedValues]) {
      expect(includes(printed, value), 'the notice printed a value').toBe(false);
    }
  });

  describe('child launchers, each run from a copy of the checkout with a recording wrangler', () => {
    const FAKE_WRANGLER = `import { appendFileSync } from 'node:fs';
const LOG = new URL('../../wrangler-calls.ndjson', import.meta.url);
const record = (event, detail) => appendFileSync(LOG, JSON.stringify({ event, environment: { ...process.env }, ...detail }) + '\\n');
record('import', {});
export async function createTestHarness(options) {
  record('createTestHarness', { options });
  return { listen: async () => ({ url: new URL('http://127.0.0.1:9/') }), close: async () => {} };
}
export function unstable_readConfig() { return {}; }
export async function unstable_startWorker(options) {
  record('unstable_startWorker', { options });
  return { ready: Promise.resolve(), url: Promise.resolve(new URL('http://127.0.0.1:9/')), dispose: async () => {} };
}
`;

    function sandbox(files: string[]): { dir: string; calls: () => Array<Record<string, unknown>> } {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'oi-hygiene-'));
      for (const file of ['scripts/cloudflare/credential-env.mjs', ...files]) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        copyFileSync(path.join(ROOT, file), path.join(dir, file));
      }
      mkdirSync(path.join(dir, 'dist/cloudflare/artifact/worker'), { recursive: true });
      writeFileSync(path.join(dir, 'dist/cloudflare/artifact/worker/worker.js'), 'export default {};\n');
      mkdirSync(path.join(dir, 'node_modules/wrangler'), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules/wrangler/package.json'), JSON.stringify({ name: 'wrangler', type: 'module', exports: './index.mjs' }));
      writeFileSync(path.join(dir, 'node_modules/wrangler/index.mjs'), FAKE_WRANGLER);
      return {
        dir,
        calls: () => readFileSync(path.join(dir, 'wrangler-calls.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
      };
    }

    /** Runs `args` until `ready` appears in its output, then kills its process group. */
    function runUntilReady(cwd: string, args: string[], ready: string): Promise<{ output: string; code: number | null }> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, [PLANTED]: PLANTED_VALUE, [SECOND]: SECOND_VALUE } as unknown as NodeJS.ProcessEnv,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let settled = false;
        const stop = () => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        };
        const timer = setTimeout(() => {
          stop();
          if (!settled) reject(new Error(`launcher not ready within 30 s: ${output.slice(0, 400)}`));
          settled = true;
        }, 30_000);
        const onData = (chunk: Buffer) => {
          output += chunk.toString();
          if (!settled && output.includes(ready)) {
            settled = true;
            clearTimeout(timer);
            stop();
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          if (!settled) settled = true;
          resolve({ output, code });
        });
      });
    }

    function expectScrubbed(output: string, notice: string, calls: Array<Record<string, unknown>>, startEvent: string) {
      expect(output).toContain(`${notice}: removed credential-like environment variables (names only): ${PLANTED}, ${SECOND}`);
      expect(calls.map((call) => call.event)).toEqual(['import', startEvent]);
      for (const call of calls) {
        const environment = call.environment as Record<string, string>;
        expect(inheritedCredentialNames(environment), String(call.event)).toEqual([]);
      }
      const texts = [output, ...calls.map((call) => JSON.stringify(call))];
      for (const value of [PLANTED_VALUE, SECOND_VALUE]) {
        for (const text of texts) expect(includes(text, value), 'a scrubbed value reached wrangler or the output').toBe(false);
      }
    }

    it('the Cloudflare browser server scrubs, then loads wrangler and starts with synthetic secrets only', async () => {
      const box = sandbox(['tests/e2e-cloudflare/server.mjs', 'tests/e2e-cloudflare/fixtureData.mjs']);
      try {
        const result = await runUntilReady(box.dir, [path.join(box.dir, 'tests/e2e-cloudflare/server.mjs'), '0'], 'ready on');
        expect(result.output).toContain('cloudflare artifact e2e server ready on');
        const calls = box.calls();
        expectScrubbed(result.output, 'cloudflare e2e server', calls, 'createTestHarness');
        const [worker] = (calls[1].options as { workers: Array<{ secrets: Record<string, string> }> }).workers;
        expect(Object.keys(worker.secrets).sort()).toEqual([
          'ADMIN_PASSWORD', 'OPENAI_API_KEY', 'OPERATOR_TOKEN', 'PARTICIPANT_TOKEN_SECRET', 'RATE_LIMIT_SALT', 'SESSION_SECRET',
        ]);
      } finally {
        rmSync(box.dir, { recursive: true, force: true });
      }
    });

    it('the restart runner scrubs as a backstop, then loads wrangler and binds synthetic secrets only', async () => {
      const box = sandbox([
        'tests/cloudflare-restart/runner.mjs',
        'tests/cloudflare-restart/synthetic.mjs',
        'tests/e2e-cloudflare/fixtureData.mjs',
      ]);
      const state = path.join(box.dir, 'state');
      mkdirSync(state);
      try {
        const result = await runUntilReady(
          box.dir,
          [path.join(box.dir, 'tests/cloudflare-restart/runner.mjs'), '--state', state, '--runtime', 'hygiene'],
          READY_PREFIX,
        );
        const calls = box.calls();
        expectScrubbed(result.output, 'restart runner', calls, 'unstable_startWorker');
        const { bindings } = calls[1].options as { bindings: Record<string, { type: string }> };
        expect(Object.values(bindings).every((binding) => binding.type === 'secret_text')).toBe(true);
      } finally {
        rmSync(box.dir, { recursive: true, force: true });
      }
    });
  });
});
