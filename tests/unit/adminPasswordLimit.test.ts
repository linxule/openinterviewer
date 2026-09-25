// @vitest-environment node
//
// Gap F5: one ADMIN_PASSWORD limit everywhere on Cloudflare. The installer,
// the operator CLI, the setup checker, the readiness validator and
// POST /api/auth agree on the 1 KiB sign-in body, so a password the installer
// accepts is ready and signs in, and one it refuses is reported not ready
// rather than locking the researcher out. Node standalone sign-in reads the
// same bounded body, and its readiness and setup checks apply the same limit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined })),
}));

import {
  MAX_LOGIN_BODY_BYTES as INSTALLER_MAX_LOGIN_BODY_BYTES,
  loginBodyBytes as installerLoginBodyBytes,
} from '../../scripts/cloudflare/installer/model.mjs';
import { validateSuppliedSecret } from '../../scripts/cloudflare/installer/secrets.mjs';
import { MAX_LOGIN_BODY_BYTES as OPERATOR_MAX_LOGIN_BODY_BYTES } from '../../scripts/cloudflare/operator.mjs';
import { validateSetup } from '../../scripts/check-setup.mjs';
import { POST } from '@/app/api/auth/route';
import { validateCloudflareConfig, validateStandaloneConfig } from '@/lib/hostedConfig';
import { loginBodyBytes, MAX_CLOUDFLARE_LOGIN_BODY_BYTES, MAX_LOGIN_PASSWORD_LENGTH } from '@/lib/loginBody';
import { WORKER_INVOCATION_ACCESSOR, WORKER_RUNTIME_MARKER, type WorkerInvocation } from '@/lib/runtime/workerInvocation';

const WORKSPACE_ID = 'ws_0123456789abcdef0123456789abcdef';
const CLOUDFLARE_ENV: Record<string, string> = {
  DEPLOYMENT_TARGET: 'cloudflare',
  DEPLOYMENT_MODE: 'standalone',
  AI_TRANSPORT: 'direct',
  AI_PROVIDER: 'openai',
  APP_BASE_URL: 'https://openinterviewer.example.workers.dev',
  SESSION_SECRET: 'synthetic-session-secret-0123456789abcdefgh',
  PARTICIPANT_TOKEN_SECRET: 'synthetic-participant-secret-0123456789abcd',
  RATE_LIMIT_SALT: 'synthetic-rate-limit-salt-0123456789abcdef',
  OPERATOR_TOKEN: 'synthetic-operator-token-0123456789abcdefg',
  OPENAI_API_KEY: 'synthetic-openai-provider-key',
  WORKSPACE_ID,
  WORKSPACE_JURISDICTION: '',
  ANALYSIS_RECOVERY_EPOCH: 'ep_fedcba9876543210fedcba9876543210',
};
const BINDINGS = { workspaceStore: true, analysisQueue: true };
const NODE_ENV_VARS: Record<string, string> = {
  DEPLOYMENT_MODE: 'standalone',
  AI_TRANSPORT: 'direct',
  AI_PROVIDER: 'openai',
  APP_BASE_URL: 'https://interviews.example.org',
  SESSION_SECRET: CLOUDFLARE_ENV.SESSION_SECRET,
  PARTICIPANT_TOKEN_SECRET: CLOUDFLARE_ENV.PARTICIPANT_TOKEN_SECRET,
  RATE_LIMIT_SALT: CLOUDFLARE_ENV.RATE_LIMIT_SALT,
  KV_REST_API_URL: 'https://synthetic-password-limit.upstash.io',
  KV_REST_API_TOKEN: 'synthetic-password-limit-token',
  OPENAI_API_KEY: 'synthetic-openai-provider-key',
};

function configuredWith(password: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = { ...CLOUDFLARE_ENV, ADMIN_PASSWORD: password };
  return env as NodeJS.ProcessEnv;
}

// The largest passwords of each shape the installer accepts, and one past each.
const LONGEST_ACCEPTED = {
  ascii: 'a'.repeat(1_009),
  threeByte: '€'.repeat(336),
  escaped: '"'.repeat(504),
};
const ONE_PAST = {
  ascii: 'a'.repeat(1_010),
  threeByte: '€'.repeat(337),
  escaped: '"'.repeat(505),
};

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
let savedEnv: Record<string, string | undefined> = {};

function installInvocation(adminPassword: string): void {
  const budget = {
    admitLoginAttempt: async () => ({ status: 'admitted' }),
    refundLoginAttempt: async () => ({ status: 'refunded' }),
  };
  const invocation: WorkerInvocation = {
    env: {
      ...CLOUDFLARE_ENV,
      ADMIN_PASSWORD: adminPassword,
      WORKSPACE_STORE: { idFromName: () => ({}), getByName: () => budget },
      ANALYSIS_QUEUE: { send: async () => undefined },
    },
    identity: { kind: 'address', address: '203.0.113.7' },
    source: 'fetch',
  };
  runtimeGlobals[WORKER_RUNTIME_MARKER] = true;
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

function signIn(password: string): Promise<Response> {
  return POST(new Request('https://openinterviewer.example.workers.dev/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  }));
}

beforeEach(() => {
  savedEnv = {};
  for (const [name, value] of Object.entries(CLOUDFLARE_ENV)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete runtimeGlobals[WORKER_RUNTIME_MARKER];
  delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
});

describe('ADMIN_PASSWORD sign-in limit (gap F5)', () => {
  it('the installer and the app measure the same body against the same bound', () => {
    expect(INSTALLER_MAX_LOGIN_BODY_BYTES).toBe(MAX_CLOUDFLARE_LOGIN_BODY_BYTES);
    expect(OPERATOR_MAX_LOGIN_BODY_BYTES).toBe(MAX_CLOUDFLARE_LOGIN_BODY_BYTES);
    for (const password of [...Object.values(LONGEST_ACCEPTED), ...Object.values(ONE_PAST), 'synthetic-admin-password-1']) {
      expect(installerLoginBodyBytes(password)).toBe(loginBodyBytes(password));
    }
    for (const password of Object.values(LONGEST_ACCEPTED)) {
      expect(validateSuppliedSecret('ADMIN_PASSWORD', password)).toBe(password);
    }
    for (const password of Object.values(ONE_PAST)) {
      expect(() => validateSuppliedSecret('ADMIN_PASSWORD', password)).toThrow();
    }
  });

  it.each(Object.entries(LONGEST_ACCEPTED))('the longest %s password the installer accepts is ready and signs in', async (_shape, password) => {
    expect(validateCloudflareConfig(configuredWith(password), BINDINGS)).toEqual([]);
    installInvocation(password);
    const response = await signIn(password);
    expect(response.status).toBe(200);
  });

  it.each(Object.entries(ONE_PAST))('a %s password one past the limit is reported not ready', (_shape, password) => {
    expect(validateCloudflareConfig(configuredWith(password), BINDINGS))
      .toEqual(['admin_password_too_long']);
  });

  it('the setup checker accepts and refuses exactly the passwords readiness does', () => {
    const checkerErrors = (password: string) => validateSetup({
      target: 'cloudflare',
      mode: 'standalone',
      env: { ...CLOUDFLARE_ENV, ADMIN_PASSWORD: password },
      nodeVersion: '24.19.0',
      wrangler: { config: { vars: {} } },
    }).checks.filter((item: { status: string; code: string }) => item.status === 'error' && item.code.startsWith('env.'))
      .map((item: { code: string }) => item.code);
    for (const password of Object.values(LONGEST_ACCEPTED)) {
      expect(validateCloudflareConfig(configuredWith(password), BINDINGS)).toEqual([]);
      expect(checkerErrors(password)).toEqual([]);
    }
    for (const password of Object.values(ONE_PAST)) {
      expect(validateCloudflareConfig(configuredWith(password), BINDINGS)).toEqual(['admin_password_too_long']);
      expect(checkerErrors(password)).toEqual(['env.ADMIN_PASSWORD.too_long']);
    }
  });

  it('the ASCII maximum stated to operators is the longest password the installer accepts', () => {
    // Every UTF-16 code unit costs at least one body byte, so no accepted
    // password is longer than MAX_LOGIN_PASSWORD_LENGTH, and the ASCII one meets it.
    expect(MAX_LOGIN_PASSWORD_LENGTH).toBe(INSTALLER_MAX_LOGIN_BODY_BYTES - installerLoginBodyBytes(''));
    for (const password of Object.values(LONGEST_ACCEPTED)) {
      expect(password.length).toBeLessThanOrEqual(MAX_LOGIN_PASSWORD_LENGTH);
    }
    expect(LONGEST_ACCEPTED.ascii.length).toBe(MAX_LOGIN_PASSWORD_LENGTH);
  });

  it('the Node target applies the same limit in readiness and the setup checker', () => {
    const nodeEnv = (password: string): NodeJS.ProcessEnv => {
      const env: Record<string, string> = { ...NODE_ENV_VARS, ADMIN_PASSWORD: password };
      return env as NodeJS.ProcessEnv;
    };
    const checkerErrors = (password: string) => validateSetup({
      mode: 'standalone',
      production: true,
      env: nodeEnv(password),
      nodeVersion: '24.19.0',
    }).checks.filter((item: { status: string; code: string }) => item.status === 'error' && item.code.startsWith('env.'))
      .map((item: { code: string }) => item.code);
    for (const password of Object.values(LONGEST_ACCEPTED)) {
      expect(validateStandaloneConfig(nodeEnv(password))).toEqual([]);
      expect(checkerErrors(password)).toEqual([]);
    }
    for (const password of Object.values(ONE_PAST)) {
      expect(validateStandaloneConfig(nodeEnv(password))).toEqual(['admin_password_too_long']);
      expect(checkerErrors(password)).toEqual(['env.ADMIN_PASSWORD.too_long']);
    }
  });
});
