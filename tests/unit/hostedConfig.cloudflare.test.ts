// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisConstructor = vi.hoisted(() => vi.fn());
vi.mock('@upstash/redis', () => ({ Redis: redisConstructor }));

import {
  getPublicConfig,
  validateCloudflareConfig,
  workerBindingPresence,
  workspaceReadinessError,
  type CloudflareBindingPresence,
} from '@/lib/hostedConfig';
import { WORKER_INVOCATION_ACCESSOR, type WorkerInvocation } from '@/lib/runtime/workerInvocation';
import { SDK_ENV_OVERRIDE_NAMES } from '@/lib/providers/endpoint';

const ADMIN = 'synthetic-admin-password-1';
const SESSION = 'synthetic-session-secret-0123456789abcdefgh';
const PARTICIPANT = 'synthetic-participant-secret-0123456789abcd';
const SALT = 'synthetic-rate-limit-salt-0123456789abcdef';
const OPERATOR = 'synthetic-operator-token-0123456789abcdefg';
const GEMINI = 'synthetic-gemini-provider-key';
const BINDINGS: CloudflareBindingPresence = { workspaceStore: true, analysisQueue: true };
const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;

function cloudflareEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    DEPLOYMENT_TARGET: 'cloudflare',
    DEPLOYMENT_MODE: 'standalone',
    AI_TRANSPORT: 'direct',
    APP_BASE_URL: 'https://openinterviewer.example.workers.dev',
    ADMIN_PASSWORD: ADMIN,
    SESSION_SECRET: SESSION,
    PARTICIPANT_TOKEN_SECRET: PARTICIPANT,
    RATE_LIMIT_SALT: SALT,
    OPERATOR_TOKEN: OPERATOR,
    GEMINI_API_KEY: GEMINI,
    WORKSPACE_ID: 'ws_0123456789abcdef0123456789abcdef',
    WORKSPACE_JURISDICTION: '',
    WORKSPACE_BOOTSTRAP: '',
    ANALYSIS_RECOVERY_EPOCH: 'ep_fedcba9876543210fedcba9876543210',
    ...overrides,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env as NodeJS.ProcessEnv;
}

function installInvocation(env: Record<string, unknown>): void {
  const invocation: WorkerInvocation = { env, identity: null, source: 'fetch' };
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => invocation;
}

beforeEach(() => {
  redisConstructor.mockClear();
});

afterEach(() => {
  delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
  expect(redisConstructor).not.toHaveBeenCalled();
});

describe('RT-08 Cloudflare configuration validation', () => {
  it('RT-08 accepts a complete Cloudflare standalone configuration without Redis', () => {
    expect(validateCloudflareConfig(cloudflareEnv(), BINDINGS)).toEqual([]);
    expect(getPublicConfig(cloudflareEnv(), BINDINGS)).toEqual({
      mode: 'standalone',
      aiTransport: 'direct',
      ready: true,
      oauth: { google: false, github: false },
      errors: [],
      analysisExecution: 'queued-v2',
    });
  });

  it('RT-08 accepts absent transport, eu and fedramp jurisdictions and extra provider keys', () => {
    expect(getPublicConfig(cloudflareEnv({ AI_TRANSPORT: undefined }), BINDINGS).ready).toBe(true);
    expect(getPublicConfig(cloudflareEnv({ WORKSPACE_JURISDICTION: 'eu' }), BINDINGS).ready).toBe(true);
    expect(getPublicConfig(cloudflareEnv({ WORKSPACE_JURISDICTION: 'fedramp' }), BINDINGS).ready).toBe(true);
    expect(getPublicConfig(cloudflareEnv({ WORKSPACE_JURISDICTION: undefined }), BINDINGS).ready).toBe(true);
    expect(getPublicConfig(cloudflareEnv({
      OPENAI_API_KEY: 'synthetic-openai-key',
      ANTHROPIC_API_KEY: 'synthetic-anthropic-key',
    }), BINDINGS).ready).toBe(true);
  });

  it('RT-08 never requires Redis credentials', () => {
    const env = cloudflareEnv({ KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined });
    expect(validateCloudflareConfig(env, BINDINGS)).toEqual([]);
    expect(validateCloudflareConfig(cloudflareEnv({ KV_REST_API_URL: 'not-a-url' }), BINDINGS)).toEqual([]);
  });

  it.each([
    ['DEPLOYMENT_TARGET', 'Cloudflare', 'invalid_deployment_target'],
    ['DEPLOYMENT_MODE', undefined, 'missing_deployment_mode'],
    ['DEPLOYMENT_MODE', 'hosted', 'unsupported_cloudflare_mode'],
    ['DEPLOYMENT_MODE', 'standalon', 'invalid_deployment_mode'],
    ['AI_TRANSPORT', 'gateway', 'unsupported_cloudflare_transport'],
    ['AI_TRANSPORT', 'grpc', 'invalid_ai_transport'],
  ])('RT-01 refuses %s=%j before validating anything else', (name, value, error) => {
    const view = getPublicConfig(cloudflareEnv({ [name]: value }), BINDINGS);
    expect(view).toEqual({
      mode: null,
      aiTransport: null,
      ready: false,
      oauth: { google: false, github: false },
      errors: [error],
      analysisExecution: null,
    });
  });

  it('RT-01 treats a missing mode as an error even in development', () => {
    const view = getPublicConfig(cloudflareEnv({ DEPLOYMENT_MODE: undefined, NODE_ENV: 'development' }), BINDINGS);
    expect(view.errors).toEqual(['missing_deployment_mode']);
  });

  it.each([
    [undefined, 'missing_app_base_url'],
    ['http://openinterviewer.example.workers.dev', 'insecure_app_base_url'],
    ['https://localhost', 'insecure_app_base_url'],
    ['https://127.0.0.1', 'insecure_app_base_url'],
    ['https://[::1]', 'insecure_app_base_url'],
    ['https://preview.localhost', 'insecure_app_base_url'],
    ['https://user:pass@openinterviewer.example', 'invalid_app_base_url'],
    ['https://openinterviewer.example/app', 'invalid_app_base_url'],
    ['https://openinterviewer.example/?q=1', 'invalid_app_base_url'],
    ['https://openinterviewer.example/#fragment', 'invalid_app_base_url'],
    ['not a url', 'invalid_app_base_url'],
  ])('RT-06 rejects APP_BASE_URL %j with %s regardless of NODE_ENV', (value, error) => {
    for (const NODE_ENV of [undefined, 'development', 'production']) {
      expect(validateCloudflareConfig(cloudflareEnv({ APP_BASE_URL: value, NODE_ENV }), BINDINGS))
        .toEqual([error]);
    }
  });

  it('RT-08 requires the administrator password and independent secrets', () => {
    expect(validateCloudflareConfig(cloudflareEnv({ ADMIN_PASSWORD: undefined }), BINDINGS))
      .toEqual(['missing_admin_password']);
    expect(validateCloudflareConfig(cloudflareEnv({ ADMIN_PASSWORD: 'short-password' }), BINDINGS))
      .toEqual(['weak_admin_password']);
    expect(validateCloudflareConfig(cloudflareEnv({ SESSION_SECRET: undefined }), BINDINGS))
      .toEqual(['missing_session_secret']);
    expect(validateCloudflareConfig(cloudflareEnv({ PARTICIPANT_TOKEN_SECRET: 'x'.repeat(31) }), BINDINGS))
      .toEqual(['weak_participant_token_secret']);
    expect(validateCloudflareConfig(cloudflareEnv({ RATE_LIMIT_SALT: '' }), BINDINGS))
      .toEqual(['missing_rate_limit_salt']);
  });

  it.each([
    ['1,009 ASCII characters (a 1,024-byte body)', 'a'.repeat(1_009), []],
    ['1,010 ASCII characters (a 1,025-byte body)', 'a'.repeat(1_010), ['admin_password_too_long']],
    ['342 three-byte characters', '€'.repeat(342), ['admin_password_too_long']],
    ['505 characters JSON must escape', '"'.repeat(505), ['admin_password_too_long']],
  ])('F5 refuses an ADMIN_PASSWORD whose sign-in body cannot fit the 1 KiB bound: %s', (_label, password, errors) => {
    expect(validateCloudflareConfig(cloudflareEnv({ ADMIN_PASSWORD: password }), BINDINGS)).toEqual(errors);
  });

  it('F5 reports an unusable password on the public readiness view like any other configuration error', () => {
    const config = getPublicConfig(cloudflareEnv({ ADMIN_PASSWORD: 'a'.repeat(1_010) }), BINDINGS);
    expect(config).toMatchObject({ ready: false, errors: ['admin_password_too_long'] });
  });

  it.each([
    ['SESSION_SECRET', 'PARTICIPANT_TOKEN_SECRET'],
    ['SESSION_SECRET', 'RATE_LIMIT_SALT'],
    ['PARTICIPANT_TOKEN_SECRET', 'RATE_LIMIT_SALT'],
    ['SESSION_SECRET', 'ADMIN_PASSWORD'],
    ['OPERATOR_TOKEN', 'ADMIN_PASSWORD'],
    ['OPERATOR_TOKEN', 'SESSION_SECRET'],
    ['OPERATOR_TOKEN', 'PARTICIPANT_TOKEN_SECRET'],
    ['OPERATOR_TOKEN', 'RATE_LIMIT_SALT'],
  ])('RT-08 rejects %s reused as %s', (source, reused) => {
    const env = cloudflareEnv();
    env[reused] = env[source];
    expect(validateCloudflareConfig(env, BINDINGS)).toEqual(['secrets_not_independent']);
  });

  it.each([
    ['ADMIN_PASSWORD', 'change-me-to-a-long-password'],
    ['SESSION_SECRET', 'replace_me_with_32_random_bytes_value!!'],
    ['PARTICIPANT_TOKEN_SECRET', 'your-participant-token-secret-goes-here'],
    ['RATE_LIMIT_SALT', 'example-rate-limit-salt-0123456789abcdef'],
    ['OPERATOR_TOKEN', 'replace-me-operator-token-0123456789abcdef'],
    ['GEMINI_API_KEY', 'TODO'],
    ['GEMINI_API_KEY', 'secret'],
  ])('SETUP-02 rejects the template placeholder in %s', (name, value) => {
    const view = getPublicConfig(cloudflareEnv({ [name]: value }), BINDINGS);
    expect(view.ready).toBe(false);
    expect(view.errors).toEqual(['placeholder_secret']);
    if (value.length > 8) expect(JSON.stringify(view)).not.toContain(value);
  });

  it('SETUP-02 treats OPERATOR_TOKEN as optional for readiness but rejects a weak configured token', () => {
    expect(validateCloudflareConfig(cloudflareEnv({ OPERATOR_TOKEN: undefined }), BINDINGS)).toEqual([]);
    expect(validateCloudflareConfig(cloudflareEnv({ OPERATOR_TOKEN: '' }), BINDINGS)).toEqual([]);
    const view = getPublicConfig(cloudflareEnv({ OPERATOR_TOKEN: 'LEAK-operator-token' }), BINDINGS);
    expect(view).toMatchObject({ ready: false, errors: ['weak_operator_token'] });
    expect(JSON.stringify(view)).not.toContain('LEAK');
  });

  it('SETUP-02 reports one placeholder error for several placeholders', () => {
    expect(validateCloudflareConfig(cloudflareEnv({
      SESSION_SECRET: 'changeme-changeme-changeme-changeme',
      RATE_LIMIT_SALT: 'change me please rate limit salt value',
    }), BINDINGS)).toEqual(['placeholder_secret']);
  });

  it('RT-05 requires the selected provider key and never substitutes another provider', () => {
    expect(validateCloudflareConfig(cloudflareEnv({
      GEMINI_API_KEY: undefined,
      OPENAI_API_KEY: 'synthetic-openai-key',
    }), BINDINGS)).toEqual(['missing_ai_provider_key']);
    expect(validateCloudflareConfig(cloudflareEnv({
      AI_PROVIDER: 'openai',
      GEMINI_API_KEY: undefined,
      OPENAI_API_KEY: 'synthetic-openai-key',
    }), BINDINGS)).toEqual([]);
    expect(validateCloudflareConfig(cloudflareEnv({
      AI_PROVIDER: 'claude',
      ANTHROPIC_API_KEY: undefined,
    }), BINDINGS)).toEqual(['missing_ai_provider_key']);
    expect(validateCloudflareConfig(cloudflareEnv({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k'.repeat(20) }), BINDINGS))
      .toEqual([]);
    expect(validateCloudflareConfig(cloudflareEnv({ AI_PROVIDER: 'mistral' }), BINDINGS))
      .toEqual(['invalid_ai_provider']);
    expect(validateCloudflareConfig(cloudflareEnv({ AI_PROVIDER: 'toString' }), BINDINGS))
      .toEqual(['invalid_ai_provider']);
  });

  it('RT-05 accepts any bound subset of the four keys that includes the default provider key', () => {
    const allKeys = {
      GEMINI_API_KEY: GEMINI,
      ANTHROPIC_API_KEY: 'synthetic-anthropic-provider-key',
      OPENAI_API_KEY: 'synthetic-openai-provider-key',
      OPENROUTER_API_KEY: 'synthetic-openrouter-provider-key',
    };
    expect(validateCloudflareConfig(cloudflareEnv(allKeys), BINDINGS)).toEqual([]);
    expect(validateCloudflareConfig(cloudflareEnv({ ...allKeys, AI_PROVIDER: 'openrouter' }), BINDINGS)).toEqual([]);
    expect(validateCloudflareConfig(cloudflareEnv({ ...allKeys, AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: undefined }), BINDINGS))
      .toEqual(['missing_ai_provider_key']);
  });

  it.each(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'])(
    'RT-05 holds a bound non-default key (%s) to the placeholder rule',
    (name) => {
      const view = getPublicConfig(cloudflareEnv({ [name]: 'your-provider-key-here' }), BINDINGS);
      expect(view).toMatchObject({ ready: false, errors: ['placeholder_secret'] });
      expect(JSON.stringify(view)).not.toContain('your-provider-key-here');
    },
  );

  it.each(SDK_ENV_OVERRIDE_NAMES)('RT-05 refuses the SDK override variable %s, whatever its value', (name) => {
    for (const value of ['https://attacker.example', '']) {
      const view = getPublicConfig(cloudflareEnv({ [name]: value }), BINDINGS);
      expect(view).toMatchObject({ ready: false, errors: ['provider_sdk_env_override'] });
      expect(JSON.stringify(view)).not.toContain('attacker');
      expect(JSON.stringify(view)).not.toContain(name);
    }
  });

  describe('RT-11 Cloudflare AI Gateway transport', () => {
    const GATEWAY = {
      AI_TRANSPORT: 'cloudflare-gateway',
      CF_AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      CF_AI_GATEWAY_ID: 'oi-example',
      CF_AI_GATEWAY_TOKEN: 'synthetic-ai-gateway-run-token-0123456789',
    };

    it('is ready with valid identifiers and an independent Run token, and reports the transport', () => {
      const view = getPublicConfig(cloudflareEnv(GATEWAY), BINDINGS);
      expect(view).toMatchObject({ ready: true, errors: [], aiTransport: 'cloudflare-gateway' });
      expect(JSON.stringify(view)).not.toContain(GATEWAY.CF_AI_GATEWAY_TOKEN);
      expect(JSON.stringify(view)).not.toContain(GATEWAY.CF_AI_GATEWAY_ACCOUNT_ID);
    });

    it.each<[string, Record<string, string | undefined>, string]>([
      ['a malformed account ID', { CF_AI_GATEWAY_ACCOUNT_ID: 'not-an-account' }, 'invalid_cf_ai_gateway_account_id'],
      ['the default gateway', { CF_AI_GATEWAY_ID: 'default' }, 'invalid_cf_ai_gateway_id'],
      ['a missing Run token', { CF_AI_GATEWAY_TOKEN: undefined }, 'missing_cf_ai_gateway_token'],
      ['a short Run token', { CF_AI_GATEWAY_TOKEN: 'short-token' }, 'weak_cf_ai_gateway_token'],
    ])('refuses %s', (_label, override, error) => {
      const view = getPublicConfig(cloudflareEnv({ ...GATEWAY, ...override }), BINDINGS);
      expect(view).toMatchObject({ ready: false, errors: [error], aiTransport: 'cloudflare-gateway' });
    });

    it('refuses gateway identifiers on direct transport, but allows a bound token there', () => {
      expect(validateCloudflareConfig(cloudflareEnv({ CF_AI_GATEWAY_ID: 'oi-example' }), BINDINGS))
        .toEqual(['cf_ai_gateway_config_without_transport']);
      expect(validateCloudflareConfig(cloudflareEnv({ CF_AI_GATEWAY_ACCOUNT_ID: GATEWAY.CF_AI_GATEWAY_ACCOUNT_ID }), BINDINGS))
        .toEqual(['cf_ai_gateway_config_without_transport']);
      expect(validateCloudflareConfig(cloudflareEnv({ CF_AI_GATEWAY_TOKEN: GATEWAY.CF_AI_GATEWAY_TOKEN }), BINDINGS)).toEqual([]);
    });

    it.each([
      ['the session secret', SESSION],
      ['the administrator password', ADMIN],
      ['the operator token', OPERATOR],
      ['the default provider key', GEMINI],
    ])('requires a Run token independent of %s', (_label, value) => {
      const env = cloudflareEnv({ ...GATEWAY, CF_AI_GATEWAY_TOKEN: value });
      const errors = validateCloudflareConfig(env, BINDINGS);
      expect(errors).toContain('secrets_not_independent');
      expect(JSON.stringify(getPublicConfig(env, BINDINGS))).not.toContain(value);
    });

    it('requires a Run token independent of a bound non-default provider key', () => {
      const key = 'synthetic-openrouter-provider-key-0123';
      expect(validateCloudflareConfig(cloudflareEnv({ ...GATEWAY, OPENROUTER_API_KEY: key, CF_AI_GATEWAY_TOKEN: key }), BINDINGS))
        .toEqual(['secrets_not_independent']);
    });

    it('holds the Run token to the placeholder rule', () => {
      const view = getPublicConfig(cloudflareEnv({ ...GATEWAY, CF_AI_GATEWAY_TOKEN: 'your-ai-gateway-run-token-goes-here' }), BINDINGS);
      expect(view).toMatchObject({ ready: false, errors: ['placeholder_secret'] });
    });

    it('keeps Vercel AI Gateway refused on Cloudflare', () => {
      expect(getPublicConfig(cloudflareEnv({ AI_TRANSPORT: 'gateway' }), BINDINGS))
        .toMatchObject({ ready: false, errors: ['unsupported_cloudflare_transport'], aiTransport: null });
    });
  });

  it.each([
    ['WORKSPACE_ID', undefined, 'invalid_workspace_id'],
    ['WORKSPACE_ID', '', 'invalid_workspace_id'],
    ['WORKSPACE_ID', 'ws_0123456789ABCDEF0123456789abcdef', 'invalid_workspace_id'],
    ['WORKSPACE_ID', 'ws_0123456789abcdef', 'invalid_workspace_id'],
    ['WORKSPACE_ID', ' ws_0123456789abcdef0123456789abcdef', 'invalid_workspace_id'],
    ['WORKSPACE_JURISDICTION', 'EU', 'invalid_workspace_jurisdiction'],
    ['WORKSPACE_JURISDICTION', 'us', 'invalid_workspace_jurisdiction'],
    ['WORKSPACE_JURISDICTION', ' eu', 'invalid_workspace_jurisdiction'],
    ['ANALYSIS_RECOVERY_EPOCH', undefined, 'invalid_analysis_recovery_epoch'],
    ['ANALYSIS_RECOVERY_EPOCH', 'ep_xyz', 'invalid_analysis_recovery_epoch'],
    ['ANALYSIS_RECOVERY_EPOCH', 'ws_0123456789abcdef0123456789abcdef', 'invalid_analysis_recovery_epoch'],
    ['WORKSPACE_BOOTSTRAP', 'yes-please', 'invalid_workspace_bootstrap'],
    ['WORKSPACE_BOOTSTRAP', 'OPEN', 'invalid_workspace_bootstrap'],
    ['WORKSPACE_BOOTSTRAP', ' open', 'invalid_workspace_bootstrap'],
  ])('ST-01 rejects %s=%j', (name, value, error) => {
    expect(validateCloudflareConfig(cloudflareEnv({ [name]: value }), BINDINGS)).toEqual([error]);
  });

  it.each([undefined, '', 'open', 'recovery'])('ST-01 accepts WORKSPACE_BOOTSTRAP=%j', (value) => {
    expect(validateCloudflareConfig(cloudflareEnv({ WORKSPACE_BOOTSTRAP: value }), BINDINGS)).toEqual([]);
  });

  it('RT-08 requires both bindings from the current invocation', () => {
    expect(validateCloudflareConfig(cloudflareEnv(), { workspaceStore: false, analysisQueue: true }))
      .toEqual(['missing_workspace_store_binding']);
    expect(validateCloudflareConfig(cloudflareEnv(), { workspaceStore: true, analysisQueue: false }))
      .toEqual(['missing_analysis_queue_binding']);
  });

  it('RT-08 reads binding presence from the Worker invocation, never process.env', () => {
    const env = cloudflareEnv({ WORKSPACE_STORE: 'present', ANALYSIS_QUEUE: 'present' });
    expect(getPublicConfig(env).errors).toEqual([
      'missing_workspace_store_binding',
      'missing_analysis_queue_binding',
    ]);

    installInvocation({
      WORKSPACE_STORE: { idFromName: () => ({}), getByName: () => ({}) },
      ANALYSIS_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
    });
    expect(workerBindingPresence()).toEqual({ workspaceStore: true, analysisQueue: true });
    expect(getPublicConfig(cloudflareEnv())).toMatchObject({ ready: true, errors: [] });

    installInvocation({ WORKSPACE_STORE: 'not-a-namespace', ANALYSIS_QUEUE: {} });
    expect(workerBindingPresence()).toEqual({ workspaceStore: false, analysisQueue: false });
  });

  it('RT-08 analysisExecution never overrides ready:false', () => {
    const view = getPublicConfig(cloudflareEnv({ SESSION_SECRET: 'short' }), { workspaceStore: false, analysisQueue: false });
    expect(view.ready).toBe(false);
    expect(view.analysisExecution).toBe('queued-v2');
    expect(view.errors).toEqual([
      'weak_session_secret',
      'missing_workspace_store_binding',
      'missing_analysis_queue_binding',
    ]);
  });

  it('RT-08 exposes safe identifiers only, never configured values', () => {
    const env = cloudflareEnv({
      SESSION_SECRET: 'LEAK-short',
      ADMIN_PASSWORD: 'LEAK-admin',
      APP_BASE_URL: 'http://LEAK.example',
      WORKSPACE_ID: 'LEAK-workspace',
      ANALYSIS_RECOVERY_EPOCH: 'LEAK-epoch',
      WORKSPACE_JURISDICTION: 'LEAK',
    });
    const serialized = JSON.stringify(getPublicConfig(env, BINDINGS));
    expect(serialized).not.toMatch(/LEAK/i);
    expect(serialized).not.toContain(GEMINI);
    expect(serialized).not.toContain(SALT);
  });
});

describe('RT-01 Node target keeps its existing validation', () => {
  const nodeEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    DEPLOYMENT_MODE: 'standalone',
    APP_BASE_URL: 'https://standalone.example',
    ADMIN_PASSWORD: ADMIN,
    SESSION_SECRET: SESSION,
    PARTICIPANT_TOKEN_SECRET: PARTICIPANT,
    RATE_LIMIT_SALT: SALT,
    KV_REST_API_URL: 'https://standalone.upstash.io',
    KV_REST_API_TOKEN: 'redis-token',
    GEMINI_API_KEY: GEMINI,
  };

  it('RT-01 treats an explicit node target exactly like the absent default', () => {
    expect(getPublicConfig({ ...nodeEnv, DEPLOYMENT_TARGET: 'node' })).toEqual(getPublicConfig(nodeEnv));
    expect(getPublicConfig(nodeEnv)).toMatchObject({ ready: true, analysisExecution: 'synchronous' });
  });

  it('RT-01 ignores Cloudflare bindings and variables on the Node target', () => {
    installInvocation({ WORKSPACE_STORE: { idFromName: () => ({}) }, ANALYSIS_QUEUE: { send: async () => undefined } });
    expect(getPublicConfig({
      ...nodeEnv,
      WORKSPACE_ID: 'invalid',
      WORKSPACE_BOOTSTRAP: 'yes-please',
      OPERATOR_TOKEN: SESSION,
    })).toMatchObject({ ready: true, errors: [] });
    expect(getPublicConfig({ ...nodeEnv, KV_REST_API_URL: undefined }).errors).toEqual(['missing_standalone_redis_url']);
  });

  it('F5 holds the Node target to the same sign-in body bound', () => {
    expect(getPublicConfig({ ...nodeEnv, ADMIN_PASSWORD: 'a'.repeat(1_009) })).toMatchObject({ ready: true, errors: [] });
    expect(getPublicConfig({ ...nodeEnv, ADMIN_PASSWORD: 'a'.repeat(2_000) })).toMatchObject({
      ready: false,
      errors: ['admin_password_too_long'],
    });
  });

  it('RT-11 refuses Cloudflare AI Gateway on the Node target', () => {
    const view = getPublicConfig({ ...nodeEnv, AI_TRANSPORT: 'cloudflare-gateway' });
    expect(view.ready).toBe(false);
    expect(view.errors).toContain('invalid_ai_transport');
    expect(view.aiTransport).toBeNull();
  });

  it('RT-01 keeps the existing Node invalid-transport result and withholds the protocol', () => {
    const view = getPublicConfig({ ...nodeEnv, AI_TRANSPORT: 'grpc' });
    expect(view).toMatchObject({ mode: 'standalone', aiTransport: null, ready: false, analysisExecution: null });
    expect(view.errors).toContain('invalid_ai_transport');
  });

  it('RT-01 reports an invalid target without revealing it', () => {
    const view = getPublicConfig({ ...nodeEnv, DEPLOYMENT_TARGET: 'vercel-edge' });
    expect(view).toEqual({
      mode: null,
      aiTransport: null,
      ready: false,
      oauth: { google: false, github: false },
      errors: ['invalid_deployment_target'],
      analysisExecution: null,
    });
    expect(JSON.stringify(view)).not.toContain('vercel-edge');
  });
});

describe('RT-08 durable workspace readiness mapping', () => {
  it.each([
    [{ status: 'ready', maintenance: 'open' }, null],
    [{ status: 'ready', maintenance: 'draining' }, 'workspace_maintenance'],
    [{ status: 'ready', maintenance: 'frozen' }, 'workspace_maintenance'],
    [{ status: 'ready', maintenance: 'recovery' }, 'workspace_maintenance'],
    [{ status: 'held', reason: 'maintenance', maintenance: 'frozen' }, 'workspace_maintenance'],
    [{ status: 'held', reason: 'workspace-uninitialized' }, 'workspace_uninitialized'],
    [{ status: 'held', reason: 'workspace-unconfigured' }, 'workspace_unconfigured'],
    [{ status: 'held', reason: 'schema-unsupported' }, 'workspace_schema_unsupported'],
    [{ status: 'held', reason: 'workspace-identity-mismatch', maintenance: 'open' }, 'workspace_identity_mismatch'],
    [{ status: 'held', reason: 'recovery-epoch-mismatch', maintenance: 'open' }, 'workspace_recovery_epoch_mismatch'],
    [{ status: 'held', reason: 'something-new' }, 'workspace_unavailable'],
    [{ status: 'unavailable' }, 'workspace_unavailable'],
    [{ status: 'unexpected' }, 'workspace_unavailable'],
    [null, 'workspace_unavailable'],
    [undefined, 'workspace_unavailable'],
  ])('RT-08 maps %j to %s', (readiness, expected) => {
    expect(workspaceReadinessError(readiness as Parameters<typeof workspaceReadinessError>[0])).toBe(expected);
  });
});
