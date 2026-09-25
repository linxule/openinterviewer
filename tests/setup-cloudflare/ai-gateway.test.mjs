// Cloudflare AI Gateway installer support (RT-11, SETUP-08, gw-final D7,
// D13, §5): the gateway phase, adoption only on recorded evidence, the
// settings policy, the probes that make no provider call, verify's gateway
// checks, --change-ai-transport in both directions and
// --rotate-ai-gateway-token. Against the simulated account and a local fake
// of the Cloudflare API and the gateway endpoint only; the tokens are
// synthetic.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ROOT, readJsonc } from '../../scripts/cloudflare/lib.mjs';
import {
  GATEWAY_CREATE_SETTINGS,
  GatewayApi,
  gatewayCreateBody,
  gatewayRequestHeaders,
  gatewaySettingsPolicy,
  probeGateway,
  settingsDigest,
} from '../../scripts/cloudflare/installer/gateway.mjs';
import { deriveNames, requiredSecretNames } from '../../scripts/cloudflare/installer/model.mjs';
import { gatewayOwnership } from '../../scripts/cloudflare/installer/ownership.mjs';
import { suppliedSecretNames, validateSuppliedSecret } from '../../scripts/cloudflare/installer/secrets.mjs';
import { buildInstallationConfig, firstIncompletePhase, newReceipt, readReceipt } from '../../scripts/cloudflare/installer/state.mjs';
import { TRANSPORT_CONSENT_NOTES } from '../../scripts/cloudflare/installer/update.mjs';
import { GATEWAY_CONFIG_UNCHECKED_LIMITATION, GATEWAY_LIMITATION, checkDeployedConfig } from '../../scripts/cloudflare/installer/verify.mjs';
import { missingInstallationVars, realConfigDrift } from './fixtures/deploy-config-drift.mjs';
import { ACCOUNT, digest } from './fixtures/fake-state.mjs';
import {
  ADMIN_TOKEN,
  RUN_TOKEN,
  applyArgs,
  assertNoSecretLeak,
  createSandbox,
  mutations,
  resumeArgs,
  stdinSecrets,
} from './helpers.mjs';

const template = readJsonc(path.join(ROOT, 'wrangler.jsonc'));
const GATEWAY = 'oi-acme';
const KEY = `${ACCOUNT.id}/${GATEWAY}`;
const PROBE_PATH = `/v1/${ACCOUNT.id}/${GATEWAY}/openai/chat/completions`;
const ADMIN_ENV = { CF_AI_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN };
const UPDATE = ['--install', 'acme', '--env', 'production', '--yes'];
const VERIFY = ['--install', 'acme', '--env', 'production'];
const SIX = ['cf-aig-authorization', 'cf-aig-collect-log', 'cf-aig-collect-log-payload', 'cf-aig-max-attempts', 'cf-aig-no-wholesale', 'cf-aig-skip-cache'];
const OTHER_RUN_TOKEN = 'fixture-aig-run-token-rotated-0123456789abcd';

async function gatewaySandbox(t) {
  const sandbox = await createSandbox(t);
  sandbox.update((state) => {
    state.gatewayApi.adminTokenDigest = digest(ADMIN_TOKEN);
    state.gatewayApi.runTokenDigests = [digest(RUN_TOKEN), digest(OTHER_RUN_TOKEN)];
  });
  return sandbox;
}

const gatewayApply = (sandbox, extra = []) => applyArgs(sandbox, { extra: ['--ai-transport', 'cloudflare-gateway', ...extra] });
const gatewaySecrets = (overrides = {}) => stdinSecrets({ CF_AI_GATEWAY_TOKEN: RUN_TOKEN, ...overrides });
const apiCalls = (sandbox) => sandbox.state().gatewayApi.calls;
const posts = (sandbox) => apiCalls(sandbox).filter((call) => call.method === 'POST');

async function gatewayInstalled(t) {
  const sandbox = await gatewaySandbox(t);
  const run = await sandbox.run('apply', gatewayApply(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV });
  assert.equal(run.code, 0, run.output);
  return sandbox;
}

async function directInstalled(t) {
  const sandbox = await gatewaySandbox(t);
  const run = await sandbox.run('apply', applyArgs(sandbox), { input: stdinSecrets() });
  assert.equal(run.code, 0, run.output);
  return sandbox;
}

/** A created gateway as the fake API reports it, before any drift. */
function createdGateway(overrides = {}) {
  return {
    ...gatewayCreateBody(GATEWAY),
    created_at: '2026-09-24T10:00:00.000Z',
    modified_at: '2026-09-24T10:00:00.000Z',
    is_default: false,
    logpush: false,
    rate_limiting_technique: 'fixed',
    store_id: null,
    workers_ai_billing_mode: 'postpaid',
    ...overrides,
  };
}

// Each drift the policy refuses (gw-final D7): the field, a drifted value and the refusal.
const DRIFTS = [
  ['logging on', { collect_logs: true }, /collect_logs is true: logging must be off/],
  ['caching on', { cache_ttl: 300 }, /cache_ttl is 300: caching must be off/],
  ['gateway retries set', { retry_max_attempts: 3, retry_delay: 1000, retry_backoff: 'exponential' }, /retry_max_attempts is 3: gateway retries must stay unset/],
  ['DLP present', { dlp: { action: 'BLOCK', enabled: true, profiles: ['p1'] } }, /DLP is configured/],
  ['Guardrails present', { guardrails: { prompt: { S1: 'FLAG' }, response: {} } }, /Guardrails are configured/],
  ['Logpush on', { logpush: true, logpush_public_key: 'x'.repeat(20) }, /logpush is true: Logpush must be off/],
  ['authentication off', { authentication: false }, /authentication is false/],
  ['provider keys not required', { byok_only: false }, /byok_only is false/],
  ['OTel export present', { otel: [{ url: 'https://collector.example', headers: {} }] }, /OTel export is configured/],
  ['a Secrets Store attached', { store_id: 'store-1' }, /Secrets Store \(store_id\) is attached/],
];

describe('AI Gateway policy, client and probes (pure)', () => {
  test('a gateway created with the D7 settings passes the policy with no warning', () => {
    assert.deepEqual(gatewayCreateBody(GATEWAY), {
      id: GATEWAY,
      authentication: true,
      collect_logs: false,
      cache_ttl: 0,
      cache_invalidate_on_update: false,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      byok_only: true,
    });
    for (const field of ['retry_max_attempts', 'retry_delay', 'retry_backoff', 'dlp', 'guardrails', 'logpush', 'otel', 'store_id', 'zdr']) {
      assert.equal(Object.hasOwn(GATEWAY_CREATE_SETTINGS, field), false, `${field} is left unset at create`);
    }
    assert.deepEqual(gatewaySettingsPolicy(createdGateway(), { id: GATEWAY }), { refusals: [], warnings: [] });
    // Unset optional objects as the API may report them.
    assert.deepEqual(gatewaySettingsPolicy(createdGateway({ dlp: null, guardrails: { prompt: {}, response: {} }, otel: [], retry_max_attempts: 1, spend_limits: { enabled: false, rules: [] } }), { id: GATEWAY }).refusals, []);
  });

  for (const [label, drift, pattern] of DRIFTS) {
    test(`the policy refuses ${label}`, () => {
      const { refusals } = gatewaySettingsPolicy(createdGateway(drift), { id: GATEWAY });
      assert.equal(refusals.length, 1, refusals.join('; '));
      assert.match(refusals[0], pattern);
    });
  }

  test('the policy refuses another id and the default gateway, and warns on limits and unknown fields', () => {
    assert.match(gatewaySettingsPolicy(createdGateway({ id: 'oi-other' }), { id: GATEWAY }).refusals.join(), /id is "oi-other", not oi-acme/);
    assert.match(gatewaySettingsPolicy(createdGateway({ is_default: true }), { id: GATEWAY }).refusals.join(), /default gateway/);
    const { refusals, warnings } = gatewaySettingsPolicy(createdGateway({
      rate_limiting_limit: 100,
      rate_limiting_interval: 60,
      spend_limits: { enabled: true, rules: [{ limit: 1 }] },
      shiny_new_feature: true,
    }), { id: GATEWAY });
    assert.deepEqual(refusals, []);
    assert.equal(warnings.length, 4);
    assert.match(warnings.join('\n'), /rate_limiting_limit is 100/);
    assert.match(warnings.join('\n'), /spend limits are configured/);
    assert.match(warnings.join('\n'), /fields this installer does not know: shiny_new_feature/);
    assert.notEqual(settingsDigest(createdGateway()), settingsDigest(createdGateway({ collect_logs: true })));
    assert.equal(settingsDigest(createdGateway()), settingsDigest(createdGateway({ modified_at: '2027-01-01T00:00:00.000Z' })), 'timestamps are not settings');
  });

  test('the undocumented internal and wholesale fields: the values the API returns pass silently, internal true warns', () => {
    const observed = createdGateway({ internal: false, wholesale: true });
    assert.deepEqual(gatewaySettingsPolicy(observed, { id: GATEWAY }), { refusals: [], warnings: [] });
    assert.equal(settingsDigest(observed), settingsDigest(createdGateway()), 'receipts recorded before these fields keep their digest');
    const { refusals, warnings } = gatewaySettingsPolicy(createdGateway({ internal: true, wholesale: true }), { id: GATEWAY });
    assert.deepEqual(refusals, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /internal is true: an undocumented field/);
    assert.match(gatewaySettingsPolicy(createdGateway({ wholesale: true, byok_only: false }), { id: GATEWAY }).refusals.join(), /byok_only is false/);
  });

  test('ownership: observed, inside a recorded attempt, and never the default gateway', () => {
    const at = '2026-09-24T10:00:00.000Z';
    const gateway = createdGateway({ created_at: '2026-09-24T10:00:02.000Z' });
    assert.equal(gatewayOwnership(gateway, null).owned, false);
    assert.equal(gatewayOwnership(gateway, { attempts: [] }).owned, false);
    assert.equal(gatewayOwnership(gateway, { attempts: [{ at }] }).owned, true);
    assert.equal(gatewayOwnership({ ...gateway, created_at: '2026-09-24T08:00:00.000Z' }, { attempts: [{ at }] }).owned, false);
    assert.equal(gatewayOwnership(gateway, { attempts: [], observedAt: at, createdAt: gateway.created_at }).owned, true);
    assert.match(gatewayOwnership({ ...gateway, created_at: '2026-09-25T00:00:00.000Z' }, { attempts: [], observedAt: at, createdAt: gateway.created_at }).reason, /deleted and recreated/);
    assert.equal(gatewayOwnership({ ...gateway, is_default: true }, { attempts: [{ at }] }).owned, false);
  });

  test('the API client retries reads only, never echoes a response body and sends the token only as Authorization', async () => {
    const calls = [];
    const fake = (responses) => async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const [status, body] = responses.shift();
      return new Response(JSON.stringify(body), { status });
    };
    const leaky = { success: false, errors: [{ code: 7777, message: 'body text that must not be echoed' }] };
    const api = new GatewayApi({ accountId: ACCOUNT.id, adminToken: ADMIN_TOKEN, fetchImpl: fake([[503, leaky], [503, leaky], [503, leaky]]), retryDelayMs: 1 });
    await assert.rejects(api.getGateway(GATEWAY), (error) => {
      assert.match(error.message, /GET gateway oi-acme failed: HTTP 503 \(Cloudflare error code 7777\)/);
      assert.doesNotMatch(error.message, /must not be echoed/);
      return true;
    });
    assert.equal(calls.length, 3, 'a read is attempted three times');
    assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT.id}/ai-gateway/gateways/oi-acme`);
    assert.equal(calls[0].headers.authorization, `Bearer ${ADMIN_TOKEN}`);

    calls.length = 0;
    const once = new GatewayApi({ accountId: ACCOUNT.id, adminToken: ADMIN_TOKEN, fetchImpl: fake([[503, leaky]]), retryDelayMs: 1 });
    const created = await once.createGateway(gatewayCreateBody(GATEWAY));
    assert.equal(created.ok, false);
    assert.equal(calls.length, 1, 'a create is never retried');
    assert.deepEqual(JSON.parse(calls[0].body), gatewayCreateBody(GATEWAY));

    assert.equal(await new GatewayApi({ accountId: ACCOUNT.id, adminToken: ADMIN_TOKEN, fetchImpl: fake([[404, leaky]]) }).getGateway(GATEWAY), null);
    const conflict = await new GatewayApi({ accountId: ACCOUNT.id, adminToken: ADMIN_TOKEN, fetchImpl: fake([[409, leaky]]) }).createGateway(gatewayCreateBody(GATEWAY));
    assert.equal(conflict.nameTaken, true);
    assert.equal(await new GatewayApi({ accountId: ACCOUNT.id, adminToken: ADMIN_TOKEN, fetchImpl: fake([[200, { success: true, result: [], result_info: {} }]]) }).logCount(GATEWAY), null, 'no count reported is not zero');
    for (const name of ['updateGateway', 'deleteGateway', 'put', 'delete']) assert.equal(typeof GatewayApi.prototype[name], 'undefined', `the client has no ${name}`);
  });

  test('the probes send no provider credential and exactly the Worker\'s cf-aig-* set, and accept only gateway rejections', async () => {
    const sent = [];
    const answer = (responses) => async (url, init) => {
      sent.push({ url, init });
      const [status, body] = responses.shift();
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    };
    const unauthorized = { name: 'AiGatewayError', httpCode: 401, internalCode: 2009, message: 'Unauthorized' };
    const refused = { name: 'AiGatewayError', httpCode: 400, internalCode: 2021, message: 'x' };
    const ok = await probeGateway({ accountId: ACCOUNT.id, gatewayId: GATEWAY, runToken: RUN_TOKEN, fetchImpl: answer([[401, unauthorized], [400, refused]]) });
    assert.equal(ok.ok, true, JSON.stringify(ok.checks));
    assert.equal(sent.length, 2);
    for (const { url, init } of sent) {
      assert.equal(url, `https://gateway.ai.cloudflare.com${PROBE_PATH}`);
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '{}');
      for (const name of ['authorization', 'x-api-key', 'x-goog-api-key']) assert.equal(Object.hasOwn(init.headers, name), false, `no ${name}`);
    }
    assert.deepEqual(Object.keys(sent[0].init.headers).filter((name) => name.startsWith('cf-aig-')).sort(), SIX.filter((name) => name !== 'cf-aig-authorization'));
    assert.deepEqual(Object.keys(sent[1].init.headers).filter((name) => name.startsWith('cf-aig-')).sort(), SIX);
    assert.equal(sent[1].init.headers['cf-aig-authorization'], `Bearer ${RUN_TOKEN}`);
    assert.deepEqual(gatewayRequestHeaders(null), Object.fromEntries(Object.entries(gatewayRequestHeaders(RUN_TOKEN)).filter(([name]) => name !== 'cf-aig-authorization')));

    for (const [label, responses] of [
      ['a 2xx', [[401, unauthorized], [200, { choices: [] }]]],
      ['an open gateway', [[400, refused], [400, refused]]],
      ['a provider error', [[401, unauthorized], [401, { error: { message: 'Incorrect API key' } }]]],
      ['a wrong Run token', [[401, unauthorized], [401, unauthorized]]],
      ['a non-JSON body', [[401, 'Unauthorized'], [400, refused]]],
      ['another gateway error code', [[401, { ...unauthorized, internalCode: 2001 }], [400, refused]]],
    ]) {
      const result = await probeGateway({ accountId: ACCOUNT.id, gatewayId: GATEWAY, runToken: RUN_TOKEN, fetchImpl: answer(responses) });
      assert.equal(result.ok, false, label);
    }
    const anonymousOnly = await probeGateway({ accountId: ACCOUNT.id, gatewayId: GATEWAY, fetchImpl: answer([[401, unauthorized]]) });
    assert.deepEqual(anonymousOnly.checks.map((check) => check.id), ['gateway.probe.unauthenticated']);
  });

  test('secret names, the Run token rule and the generated config on each transport', () => {
    assert.deepEqual(requiredSecretNames(['gemini'], 'cloudflare-gateway').slice(-2), ['GEMINI_API_KEY', 'CF_AI_GATEWAY_TOKEN']);
    assert.equal(requiredSecretNames(['gemini'], 'direct').includes('CF_AI_GATEWAY_TOKEN'), false);
    assert.deepEqual(suppliedSecretNames(['gemini', 'claude'], 'cloudflare-gateway'), ['ADMIN_PASSWORD', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CF_AI_GATEWAY_TOKEN']);
    assert.throws(() => validateSuppliedSecret('CF_AI_GATEWAY_TOKEN', 'short-token-0123456789'), /at least 32 characters/);
    assert.throws(() => validateSuppliedSecret('CF_AI_GATEWAY_TOKEN', 'fixture aig run token with spaces 0123456789'), /contains whitespace/);
    assert.equal(validateSuppliedSecret('CF_AI_GATEWAY_TOKEN', RUN_TOKEN), RUN_TOKEN);

    const receipt = newReceipt({
      install: 'acme', environment: 'production', accountId: ACCOUNT.id, names: deriveNames('acme', 'production'), workspaceId: `ws_${'b'.repeat(32)}`,
      jurisdiction: 'eu', provider: 'gemini', providerKeys: ['gemini'], aiTransport: 'cloudflare-gateway', origin: 'https://interviews.example.org', bootstrap: 'open',
    });
    assert.equal(receipt.aiGateway.id, 'oi-acme');
    const gateway = buildInstallationConfig(template, receipt, { bootstrap: '' });
    assert.equal(gateway.vars.AI_TRANSPORT, 'cloudflare-gateway');
    assert.equal(gateway.vars.CF_AI_GATEWAY_ACCOUNT_ID, ACCOUNT.id);
    assert.equal(gateway.vars.CF_AI_GATEWAY_ID, 'oi-acme');
    assert.deepEqual(realConfigDrift(template, gateway), []);
    assert.deepEqual(missingInstallationVars(gateway.vars), []);
    assert.deepEqual(checkDeployedConfig({ template, config: gateway }).diffs, []);
    const direct = buildInstallationConfig(template, receipt, { bootstrap: '', aiTransport: 'direct' });
    assert.deepEqual([direct.vars.AI_TRANSPORT, direct.vars.CF_AI_GATEWAY_ACCOUNT_ID, direct.vars.CF_AI_GATEWAY_ID], ['direct', '', '']);
    assert.deepEqual(checkDeployedConfig({ template, config: direct }).diffs, []);

    // deploy.mjs and verify --config refuse a gateway config without identifiers, and identifiers on direct.
    assert.deepEqual(missingInstallationVars({ ...gateway.vars, CF_AI_GATEWAY_ID: '' }), ['CF_AI_GATEWAY_ID']);
    for (const [vars, pattern] of [
      [{ ...gateway.vars, CF_AI_GATEWAY_ID: 'default' }, /CF_AI_GATEWAY_ID is not a gateway id other than default/],
      [{ ...gateway.vars, CF_AI_GATEWAY_ACCOUNT_ID: 'A'.repeat(32) }, /CF_AI_GATEWAY_ACCOUNT_ID is not a 32-character/],
      [{ ...direct.vars, CF_AI_GATEWAY_ID: 'oi-acme' }, /must be empty with AI_TRANSPORT "direct"/],
      [{ ...direct.vars, AI_TRANSPORT: 'gateway' }, /vars.AI_TRANSPORT: expected "direct" or "cloudflare-gateway"/],
    ]) {
      assert.match(checkDeployedConfig({ template, config: { ...gateway, vars } }).diffs.join('\n'), pattern);
    }
  });

  test('a direct receipt is complete without the ai-gateway phase; a gateway receipt is not', () => {
    const base = { formatVersion: 2, provider: 'gemini', providerKeys: ['gemini'], secretEvents: [], names: { worker: 'oi-acme' }, accountId: ACCOUNT.id };
    const phases = Object.fromEntries(['preflight', 'identity', 'resources', 'config', 'deploy-initial', 'secrets', 'origin', 'workspace-init', 'bootstrap-clear', 'verify'].map((phase) => [phase, 'x']));
    assert.equal(firstIncompletePhase({ ...base, aiTransport: 'direct', phases }), null);
    assert.equal(firstIncompletePhase({ ...base, aiTransport: 'cloudflare-gateway', phases }), 'ai-gateway');
  });
});

describe('setup:cloudflare AI Gateway (simulated account)', { concurrency: 6 }, () => {
  test('a fresh gateway apply creates the gateway once with the D7 settings, probes it without a provider call and binds the Run token', async (t) => {
    const sandbox = await gatewaySandbox(t);
    const run = await sandbox.run('apply', gatewayApply(sandbox, ['--provider-keys', 'all']), {
      input: gatewaySecrets({ ANTHROPIC_API_KEY: 'sk-ant-fixture-claude-0123456789', OPENAI_API_KEY: 'sk-fixture-openai-0123456789ab', OPENROUTER_API_KEY: 'sk-or-fixture-openrouter-012345' }),
      env: ADMIN_ENV,
    });
    assert.equal(run.code, 0, run.output);
    const state = sandbox.state();

    // Collision check, phase read, one create, read-back; verify reads the gateway and its logs.
    assert.deepEqual(state.gatewayApi.calls.map((call) => `${call.method} ${call.path.replace(`/client/v4/accounts/${ACCOUNT.id}/ai-gateway/gateways`, '')}`), [
      'GET /oi-acme', 'GET /oi-acme', 'POST ', 'GET /oi-acme', 'GET /oi-acme', 'GET /oi-acme/logs',
    ]);
    assert.ok(state.gatewayApi.calls.every((call) => call.authorized), 'every API call carried the management token');
    assert.deepEqual(posts(sandbox)[0].body, gatewayCreateBody('oi-acme'));

    // Two probes, neither with a provider credential.
    assert.deepEqual(state.gatewayApi.probes.map((probe) => [probe.path, probe.tokenPresented, probe.providerCredential]), [
      [PROBE_PATH, false, false],
      [PROBE_PATH, true, false],
    ]);
    assert.deepEqual(Object.keys(state.gatewayApi.probes[1].cfAig).sort(), SIX);

    // The Run token goes up in the one bulk upload with everything else.
    assert.equal(state.secretBulkCalls.length, 1);
    assert.ok(state.secretBulkCalls[0].names.includes('CF_AI_GATEWAY_TOKEN'));
    assert.equal(state.workers['oi-acme'].secrets.CF_AI_GATEWAY_TOKEN, digest(RUN_TOKEN));
    assert.equal(Object.hasOwn(state.workers['oi-acme'].secrets, 'CF_AI_GATEWAY_ADMIN_TOKEN'), false, 'the management token is never bound');
    for (const deploy of state.deploys) {
      assert.deepEqual([deploy.vars.AI_TRANSPORT, deploy.vars.CF_AI_GATEWAY_ACCOUNT_ID, deploy.vars.CF_AI_GATEWAY_ID], ['cloudflare-gateway', ACCOUNT.id, 'oi-acme']);
    }

    const receipt = sandbox.receipt();
    assert.equal(receipt.aiTransport, 'cloudflare-gateway');
    assert.deepEqual(Object.keys(receipt.phases).slice(0, 5), ['preflight', 'identity', 'resources', 'ai-gateway', 'config']);
    assert.equal(receipt.aiGateway.id, 'oi-acme');
    assert.equal(receipt.aiGateway.accountId, ACCOUNT.id);
    assert.equal(receipt.aiGateway.createdAt, state.gateways[KEY].created_at);
    assert.ok(receipt.aiGateway.observedAt && receipt.aiGateway.probedAt && receipt.aiGateway.settingsCheckedAt);
    assert.equal(receipt.aiGateway.settingsDigest, settingsDigest(state.gateways[KEY]));
    assert.equal(receipt.aiGateway.attempts.length, 1);
    assert.deepEqual(receipt.lastVerification.failed, []);
    assert.equal(receipt.deployments.at(-1).aiTransport, 'cloudflare-gateway');
    assert.match(run.stdout, /✓ gateway\.settings/);
    assert.match(run.stdout, /✓ gateway\.logs +0 stored logs/);
    assert.match(run.stdout, /AI +through Cloudflare AI Gateway oi-acme/);
    assert.ok(state.gatewayApi.calls.every((call) => ['GET', 'POST'].includes(call.method)), 'never PUT, PATCH or DELETE');
    assertNoSecretLeak(sandbox, [run], ['sk-ant-fixture-claude-0123456789', 'sk-fixture-openai-0123456789ab', 'sk-or-fixture-openrouter-012345']);

    // Repeating is a no-op; verify without the management token states the limitation.
    const again = await sandbox.run('apply', gatewayApply(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV });
    assert.equal(again.code, 0, again.output);
    assert.match(again.stdout, /is complete; nothing to do/);
    const verify = await sandbox.run('verify', VERIFY);
    assert.equal(verify.code, 0, verify.output);
    assert.match(verify.stdout, /AI Gateway settings and stored logs were not read: CF_AI_GATEWAY_ADMIN_TOKEN/);
    assert.match(verify.stdout, /AI Gateway pass-through per provider is not exercised/);
    assert.equal(posts(sandbox).length, 1);
  });

  for (const [label, env, input, extra, pattern] of [
    ['without the management token', {}, gatewaySecrets(), [], /needs CF_AI_GATEWAY_ADMIN_TOKEN/],
    ['without the Run token on stdin', ADMIN_ENV, stdinSecrets(), [], /--secrets-stdin input lacks CF_AI_GATEWAY_TOKEN/],
    ['a short Run token', ADMIN_ENV, gatewaySecrets({ CF_AI_GATEWAY_TOKEN: 'short-token-012345' }), [], /CF_AI_GATEWAY_TOKEN must contain at least 32 characters/],
    ['a Run token reusing a provider key', ADMIN_ENV, gatewaySecrets({ GEMINI_API_KEY: RUN_TOKEN }), [], /reuses the value/],
    ['the Vercel gateway transport', ADMIN_ENV, gatewaySecrets(), ['--ai-transport', 'gateway'], /--ai-transport must be direct or cloudflare-gateway/],
  ]) {
    test(`a gateway apply refuses ${label} before any remote write`, async (t) => {
      const sandbox = await gatewaySandbox(t);
      const args = extra.length > 0 ? applyArgs(sandbox, { extra }) : gatewayApply(sandbox);
      const run = await sandbox.run('apply', args, { input, env });
      assert.equal(run.code, 2, run.output);
      assert.match(run.stderr, pattern);
      assert.deepEqual(mutations(sandbox.state()), []);
      assert.deepEqual(sandbox.state().gateways, {});
      assertNoSecretLeak(sandbox, [run]);
    });
  }

  test('an existing gateway without evidence is a collision refused before any remote write', async (t) => {
    const sandbox = await gatewaySandbox(t);
    sandbox.update((state) => { state.gateways[KEY] = createdGateway({ created_at: '2026-01-01T00:00:00.000Z' }); });
    const run = await sandbox.run('apply', gatewayApply(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV });
    assert.equal(run.code, 2, run.output);
    assert.match(run.stderr, /collision: AI Gateway oi-acme already exist/);
    assert.deepEqual(mutations(sandbox.state()), []);
    assert.equal(sandbox.state().gateways[KEY].created_at, '2026-01-01T00:00:00.000Z', 'left untouched');
  });

  test('a create whose reply is lost is adopted inside the attempt window, in the same run or on resume, and never created twice', async (t) => {
    // Same run: the reply is lost, the read-back finds the gateway created inside the attempt.
    const inRun = await gatewaySandbox(t);
    inRun.update((state) => { state.gatewayApi.failures.push({ at: 'create', when: 'after' }); });
    const first = await inRun.run('apply', gatewayApply(inRun), { input: gatewaySecrets(), env: ADMIN_ENV });
    assert.equal(first.code, 0, first.output);
    assert.equal(posts(inRun).length, 1);
    assert.ok(inRun.receipt().aiGateway.observedAt);

    // Across runs: the reply and the read-back fail, the run stops; resume adopts it.
    const sandbox = await gatewaySandbox(t);
    sandbox.update((state) => {
      state.gatewayApi.failures.push({ at: 'create', when: 'after' }, { at: 'get', skip: 2, status: 503 }, { at: 'get', status: 503 }, { at: 'get', status: 503 });
    });
    const stopped = await sandbox.run('apply', gatewayApply(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV });
    assert.equal(stopped.code, 1, stopped.output);
    assert.match(stopped.stderr, /GET gateway oi-acme failed: HTTP 503/);
    let receipt = sandbox.receipt();
    assert.equal(receipt.aiGateway.attempts.length, 1);
    assert.equal(receipt.aiGateway.observedAt, null);
    assert.equal(receipt.phases['ai-gateway'], undefined);
    assert.ok(sandbox.state().gateways[KEY], 'the create landed');

    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV });
    assert.equal(resumed.code, 0, resumed.output);
    assert.equal(posts(sandbox).length, 1, 'adopted, not created again');
    receipt = sandbox.receipt();
    assert.equal(receipt.aiGateway.createdAt, sandbox.state().gateways[KEY].created_at);
    assert.ok(receipt.phases['ai-gateway']);
    assertNoSecretLeak(sandbox, [stopped, resumed]);
  });

  test('a gateway created outside every recorded attempt is refused on resume', async (t) => {
    const sandbox = await gatewaySandbox(t);
    sandbox.update((state) => {
      state.gatewayApi.failures.push({ at: 'create', when: 'after' }, { at: 'get', skip: 2, status: 503 }, { at: 'get', status: 503 }, { at: 'get', status: 503 });
    });
    assert.equal((await sandbox.run('apply', gatewayApply(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV })).code, 1);
    // Someone else's gateway with that id, made an hour before the attempt.
    sandbox.update((state) => { state.gateways[KEY].created_at = new Date(Date.now() - 3_600_000).toISOString(); });
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV });
    assert.equal(resumed.code, 2, resumed.output);
    assert.match(resumed.stderr, /AI Gateway oi-acme exists .* cannot show that it created it \(created .*, outside every recorded create attempt/);
    assert.equal(posts(sandbox).length, 1);
    assert.deepEqual(sandbox.state().secretBulkCalls, []);
  });

  test('a created gateway whose settings drift is refused, kept, never corrected, and adopted after the operator fixes it', async (t) => {
    const sandbox = await gatewaySandbox(t);
    // Cloudflare reporting logging on although the create asked for it off.
    sandbox.update((state) => { state.gatewayApi.createOverrides = { collect_logs: true }; });
    const refused = await sandbox.run('apply', gatewayApply(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV });
    assert.equal(refused.code, 2, refused.output);
    assert.match(refused.stderr, /breaks the installation's gateway policy/);
    assert.match(refused.stderr, /collect_logs is true: logging must be off/);
    assert.match(refused.stderr, /never changes \(PUT\) or deletes a gateway/);
    let state = sandbox.state();
    assert.deepEqual(state.secretBulkCalls, [], 'nothing further happened');
    assert.deepEqual(state.deploys, []);
    assert.deepEqual(state.gatewayApi.probes, []);
    assert.ok(state.gateways[KEY], 'the gateway is kept');
    assert.ok(state.gatewayApi.calls.every((call) => ['GET', 'POST'].includes(call.method)));
    assert.ok(sandbox.receipt().aiGateway.observedAt, 'recorded as this installation\'s');

    sandbox.update((next) => { next.gateways[KEY].collect_logs = false; });
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV });
    assert.equal(resumed.code, 0, resumed.output);
    state = sandbox.state();
    assert.equal(posts(sandbox).length, 1);
    assert.equal(state.gatewayApi.probes.length, 2);
  });

  test('verify --config on a gateway config states that the gateway was neither exercised nor read, and reads nothing', async (t) => {
    const sandbox = await gatewayInstalled(t);
    const file = path.join(sandbox.dir, 'promoted gateway wrangler.json');
    writeFileSync(file, JSON.stringify(sandbox.config()));
    // A drifted, logging gateway: verify --config cannot see it, so it must say so.
    sandbox.update((state) => { state.gateways[KEY] = { ...state.gateways[KEY], collect_logs: true }; state.gatewayApi.logCounts[KEY] = 5; });
    const calls = apiCalls(sandbox).length;
    for (const env of [{}, ADMIN_ENV]) {
      const run = await sandbox.run('verify', ['--config', file, '--json'], { extraArgs: false, env });
      assert.equal(run.code, 0, run.output);
      const result = JSON.parse(run.stdout);
      assert.equal(result.status, 'ready');
      assert.equal(result.checks.some((check) => check.id.startsWith('gateway.')), false);
      assert.ok(result.limitations.includes(GATEWAY_LIMITATION), 'pass-through and Run token not exercised');
      assert.ok(result.limitations.includes(GATEWAY_CONFIG_UNCHECKED_LIMITATION), 'settings and stored logs not read');
      const text = await sandbox.run('verify', ['--config', file], { extraArgs: false, env });
      assert.equal(text.code, 0, text.output);
      assert.match(text.stdout, /AI Gateway pass-through per provider is not exercised/);
      assert.match(text.stdout, /AI Gateway settings and stored logs were not read: verify --config/);
    }
    assert.equal(apiCalls(sandbox).length, calls, 'verify --config makes no Cloudflare API call');

    // A direct config carries neither gateway limitation.
    const direct = await directInstalled(t);
    const directFile = path.join(direct.dir, 'promoted direct wrangler.json');
    writeFileSync(directFile, JSON.stringify(direct.config()));
    const run = await direct.run('verify', ['--config', directFile, '--json'], { extraArgs: false });
    assert.equal(run.code, 0, run.output);
    const limitations = JSON.parse(run.stdout).limitations.join('\n');
    assert.doesNotMatch(limitations, /AI Gateway/);
  });

  test('update and verify refuse each settings drift of an installed gateway without deploying or correcting it', async (t) => {
    const sandbox = await gatewayInstalled(t);
    const original = sandbox.state().gateways[KEY];
    for (const [label, drift, pattern] of DRIFTS) {
      sandbox.update((state) => { state.gateways[KEY] = { ...original, ...drift }; });
      const deploys = sandbox.state().deploys.length;
      const update = await sandbox.run('update', UPDATE, { env: ADMIN_ENV });
      assert.equal(update.code, 2, `${label}\n${update.output}`);
      assert.match(update.stderr, /drift detected; nothing was changed/, label);
      assert.match(update.stderr, pattern, label);
      assert.equal(sandbox.state().deploys.length, deploys, `${label}: no deploy`);
      const verify = await sandbox.run('verify', VERIFY, { env: ADMIN_ENV });
      assert.equal(verify.code, 1, `${label}\n${verify.output}`);
      assert.match(verify.stdout, /✗ gateway\.settings/, label);
      assert.match(verify.stdout, /Result: AI GATEWAY MISMATCH/, label);
    }
    sandbox.update((state) => { state.gateways[KEY] = { ...original, rate_limiting_limit: 50, rate_limiting_interval: 60, brand_new_field: 1 }; });
    const warned = await sandbox.run('update', UPDATE, { env: ADMIN_ENV });
    assert.equal(warned.code, 0, warned.output);
    assert.match(warned.stdout, /Warning: AI Gateway oi-acme: rate_limiting_limit is 50/);
    assert.match(warned.stdout, /fields this installer does not know: brand_new_field/);

    // Stored logs fail verify; without the management token update only notes that settings were not read.
    sandbox.update((state) => { state.gatewayApi.logCounts[KEY] = 3; });
    const logged = await sandbox.run('verify', VERIFY, { env: ADMIN_ENV });
    assert.equal(logged.code, 1, logged.output);
    assert.match(logged.stdout, /✗ gateway\.logs +3 stored logs \(expected 0\)/);
    sandbox.update((state) => { state.gatewayApi.logCounts[KEY] = 0; state.gateways[KEY] = { ...original, collect_logs: true }; });
    const blind = await sandbox.run('update', UPDATE);
    assert.equal(blind.code, 0, blind.output);
    assert.match(blind.stdout, /settings of AI Gateway oi-acme were not checked: CF_AI_GATEWAY_ADMIN_TOKEN/);
    assert.ok(sandbox.state().gatewayApi.calls.every((call) => ['GET', 'POST'].includes(call.method)), 'never PUT, PATCH or DELETE');
    assert.equal(posts(sandbox).length, 1);
  });

  test('a probe that a 2xx or a non-gateway error answers stops the installer before any secret upload', async (t) => {
    for (const override of [
      { status: 200, body: { id: 'chatcmpl-1', choices: [] } },
      { status: 401, body: { error: { message: 'Incorrect API key provided' } } },
    ]) {
      const sandbox = await gatewaySandbox(t);
      sandbox.update((state) => { state.gatewayApi.probeOverride = override; });
      const run = await sandbox.run('apply', gatewayApply(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV });
      assert.equal(run.code, 2, run.output);
      assert.match(run.stderr, /probe did not answer as a gateway requiring authentication and provider keys/);
      assert.deepEqual(sandbox.state().secretBulkCalls, []);
      assert.deepEqual(sandbox.state().deploys, []);
      assert.equal(sandbox.receipt().phases['ai-gateway'], undefined);
    }
  });

  test('--change-ai-transport switches a direct installation to the gateway and back, with the consent consequences printed', async (t) => {
    const sandbox = await directInstalled(t);
    const secretsBefore = { ...sandbox.state().workers['oi-acme'].secrets };
    const toGateway = ['--change-ai-transport', '--ai-transport', 'cloudflare-gateway', '--secrets-stdin'];
    const applyMutations = mutations(sandbox.state()).length;

    const blocked = await sandbox.run('update', [...UPDATE, ...toGateway], { input: JSON.stringify({ CF_AI_GATEWAY_TOKEN: RUN_TOKEN }) });
    assert.equal(blocked.code, 2, blocked.output);
    assert.match(blocked.stderr, /switching to the Cloudflare AI Gateway transport needs CF_AI_GATEWAY_ADMIN_TOKEN/);
    assert.equal(sandbox.receipt().pendingChange, undefined);
    assert.equal(mutations(sandbox.state()).length, applyMutations, 'refused before any remote write');
    assert.deepEqual(sandbox.state().gatewayApi.calls, []);

    const deploys = sandbox.state().deploys.length;
    const run = await sandbox.run('update', [...UPDATE, ...toGateway, '--json'], { input: JSON.stringify({ CF_AI_GATEWAY_TOKEN: RUN_TOKEN }), env: ADMIN_ENV });
    assert.equal(run.code, 0, run.output);
    for (const line of TRANSPORT_CONSENT_NOTES['cloudflare-gateway']) assert.ok(run.stderr.includes(line), line);
    assert.match(run.stderr, /409 TRANSPORT_NOT_DISCLOSED/);
    let state = sandbox.state();
    assert.equal(posts(sandbox).length, 1);
    assert.deepEqual(state.secretBulkCalls.at(-1).names, ['CF_AI_GATEWAY_TOKEN'], 'only the Run token is uploaded');
    assert.equal(state.deploys.length, deploys + 1);
    assert.deepEqual([state.deploys.at(-1).vars.AI_TRANSPORT, state.deploys.at(-1).vars.CF_AI_GATEWAY_ID], ['cloudflare-gateway', 'oi-acme']);
    for (const [name, hash] of Object.entries(secretsBefore)) assert.equal(state.workers['oi-acme'].secrets[name], hash, `${name} unchanged`);
    let receipt = sandbox.receipt();
    assert.equal(receipt.aiTransport, 'cloudflare-gateway');
    assert.equal(receipt.pendingChange, undefined);
    assert.deepEqual(receipt.aiTransportHistory.map(({ from, to }) => [from, to]), [['direct', 'cloudflare-gateway']]);
    assert.ok(receipt.phases['ai-gateway']);
    const result = JSON.parse(run.stdout);
    assert.equal(result.operation, 'change-ai-transport');
    assert.equal(result.status, 'ready');
    assert.equal(result.aiTransport, 'cloudflare-gateway');
    assert.ok(result.verification.checks.some((check) => check.id === 'gateway.logs' && check.ok));
    assert.equal(JSON.parse((await sandbox.run('config', ['--install', 'acme', '--env', 'production', '--json'])).stdout).aiTransport, 'cloudflare-gateway');

    // Back to direct: no management token and no input needed; the token and the gateway are kept.
    const calls = sandbox.state().gatewayApi.calls.length;
    const back = await sandbox.run('update', [...UPDATE, '--change-ai-transport', '--ai-transport', 'direct']);
    assert.equal(back.code, 0, back.output);
    for (const line of TRANSPORT_CONSENT_NOTES.direct) assert.ok(back.stdout.includes(line), line);
    state = sandbox.state();
    assert.deepEqual([state.deploys.at(-1).vars.AI_TRANSPORT, state.deploys.at(-1).vars.CF_AI_GATEWAY_ACCOUNT_ID, state.deploys.at(-1).vars.CF_AI_GATEWAY_ID], ['direct', '', '']);
    assert.equal(state.workers['oi-acme'].secrets.CF_AI_GATEWAY_TOKEN, digest(RUN_TOKEN), 'the Run token stays bound');
    assert.ok(state.gateways[KEY], 'the gateway is kept');
    assert.equal(state.gatewayApi.calls.length, calls, 'no Cloudflare API call');
    assert.equal(sandbox.receipt().aiTransport, 'direct');

    // And to the gateway again: adopted by observation, the bound token kept, no input.
    const bulk = state.secretBulkCalls.length;
    const probes = state.gatewayApi.probes.length;
    const again = await sandbox.run('update', [...UPDATE, '--change-ai-transport', '--ai-transport', 'cloudflare-gateway'], { env: ADMIN_ENV });
    assert.equal(again.code, 0, again.output);
    assert.match(again.stdout, /CF_AI_GATEWAY_TOKEN is already bound and is kept/);
    state = sandbox.state();
    assert.equal(posts(sandbox).length, 1, 'not created again');
    assert.equal(state.secretBulkCalls.length, bulk, 'no upload');
    assert.deepEqual(state.gatewayApi.probes.slice(probes).map((probe) => probe.tokenPresented), [false], 'only the unauthenticated probe');
    receipt = sandbox.receipt();
    assert.deepEqual(receipt.aiTransportHistory.map(({ to }) => to), ['cloudflare-gateway', 'direct', 'cloudflare-gateway']);
    assert.match((await sandbox.run('apply', gatewayApply(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV })).stdout, /is complete; nothing to do/);
    assertNoSecretLeak(sandbox, [blocked, run, back, again]);
  });

  for (const [label, args, pattern] of [
    ['a switch to the current transport', ['--change-ai-transport', '--ai-transport', 'direct'], /already uses direct/],
    ['--ai-transport without --change-ai-transport', ['--ai-transport', 'cloudflare-gateway'], /Pass --change-ai-transport to switch it/],
    ['--change-ai-transport without --ai-transport', ['--change-ai-transport'], /--change-ai-transport requires --ai-transport/],
    ['two operations at once', ['--change-ai-transport', '--ai-transport', 'cloudflare-gateway', '--add-provider-key', 'openai'], /one operation at a time/],
    ['rotating a Run token the installation never had', ['--rotate-ai-gateway-token'], /this installation has no AI Gateway recorded/],
  ]) {
    test(`update refuses ${label} without any remote write`, async (t) => {
      const sandbox = await directInstalled(t);
      const before = mutations(sandbox.state()).length;
      const run = await sandbox.run('update', [...UPDATE, ...args], { env: ADMIN_ENV });
      assert.equal(run.code, 2, run.output);
      assert.match(run.stderr, pattern);
      assert.equal(mutations(sandbox.state()).length, before);
    });
  }

  test('an interrupted transport change is pending, blocks everything else, and finishes or is abandoned on rerun', async (t) => {
    const sandbox = await directInstalled(t);
    sandbox.update((state) => { state.failures.push({ at: 'deploy', target: 'oi-acme', when: 'before' }); });
    const args = [...UPDATE, '--change-ai-transport', '--ai-transport', 'cloudflare-gateway', '--secrets-stdin'];
    const first = await sandbox.run('update', args, { input: JSON.stringify({ CF_AI_GATEWAY_TOKEN: RUN_TOKEN }), env: ADMIN_ENV });
    assert.equal(first.code, 1, first.output);
    assert.match(first.stderr, /rerun update --change-ai-transport --ai-transport cloudflare-gateway to finish it/);
    const receipt = sandbox.receipt();
    assert.deepEqual([receipt.pendingChange.kind, receipt.pendingChange.from, receipt.pendingChange.to], ['ai-transport', 'direct', 'cloudflare-gateway']);
    assert.equal(receipt.aiTransport, 'direct');
    assert.equal(sandbox.state().workers['oi-acme'].secrets.CF_AI_GATEWAY_TOKEN, digest(RUN_TOKEN), 'the token landed before the deploy failed');

    for (const [command, other] of [
      ['update', UPDATE],
      ['update', [...UPDATE, '--add-provider-key', 'openai']],
      ['config', ['--install', 'acme', '--env', 'production']],
      ['resume', resumeArgs(sandbox)],
    ]) {
      const refused = await sandbox.run(command, other, { env: ADMIN_ENV });
      assert.equal(refused.code, 2, `${command} ${other.join(' ')}\n${refused.output}`);
      assert.match(refused.stderr, /the AI transport change from direct to cloudflare-gateway started at .* has not finished/);
    }
    const plan = JSON.parse((await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--json'], { env: ADMIN_ENV })).stdout);
    assert.match(plan.notes.join('\n'), /AI transport: a change from direct to cloudflare-gateway has not finished/);

    // Rerun finishes it: no second create, no second upload, no input needed.
    const bulk = sandbox.state().secretBulkCalls.length;
    const finished = await sandbox.run('update', [...UPDATE, '--change-ai-transport', '--ai-transport', 'cloudflare-gateway'], { env: ADMIN_ENV });
    assert.equal(finished.code, 0, finished.output);
    assert.equal(posts(sandbox).length, 1);
    assert.equal(sandbox.state().secretBulkCalls.length, bulk);
    assert.equal(sandbox.receipt().aiTransport, 'cloudflare-gateway');
    assert.equal(sandbox.receipt().pendingChange, undefined);

    // Abandoning another interrupted change deploys the transport it started from.
    sandbox.update((state) => { state.failures.push({ at: 'deploy', target: 'oi-acme', when: 'before' }); });
    assert.equal((await sandbox.run('update', [...UPDATE, '--change-ai-transport', '--ai-transport', 'direct'])).code, 1);
    assert.equal(sandbox.receipt().pendingChange.to, 'direct');
    const abandoned = await sandbox.run('update', [...UPDATE, '--change-ai-transport', '--ai-transport', 'cloudflare-gateway'], { env: ADMIN_ENV });
    assert.equal(abandoned.code, 0, abandoned.output);
    const after = sandbox.receipt();
    assert.equal(after.aiTransport, 'cloudflare-gateway');
    assert.equal(after.pendingChange, undefined);
    assert.deepEqual(after.aiTransportHistory.map(({ to }) => to), ['cloudflare-gateway'], 'an abandoned change adds no history');
    assert.equal(sandbox.state().deploys.at(-1).vars.AI_TRANSPORT, 'cloudflare-gateway');
    assertNoSecretLeak(sandbox, [first, finished, abandoned]);
  });

  test('--rotate-ai-gateway-token probes the new token first and uploads only it, with no deploy', async (t) => {
    const sandbox = await gatewayInstalled(t);
    const before = sandbox.state();
    const args = [...UPDATE, '--rotate-ai-gateway-token', '--secrets-stdin'];
    const rejected = await sandbox.run('update', args, { input: JSON.stringify({ CF_AI_GATEWAY_TOKEN: 'fixture-aig-token-not-on-this-account-0123' }) });
    assert.equal(rejected.code, 2, rejected.output);
    assert.match(rejected.stderr, /the new Run token was not accepted by AI Gateway oi-acme as the probe expects; nothing was uploaded/);
    assert.equal(sandbox.state().secretBulkCalls.length, before.secretBulkCalls.length);
    assert.equal(sandbox.receipt().pendingChange, undefined);

    const rotated = await sandbox.run('update', args, { input: JSON.stringify({ CF_AI_GATEWAY_TOKEN: OTHER_RUN_TOKEN }) });
    assert.equal(rotated.code, 0, rotated.output);
    const after = sandbox.state();
    assert.equal(after.deploys.length, before.deploys.length, 'no deploy');
    assert.deepEqual(after.secretBulkCalls.at(-1).names, ['CF_AI_GATEWAY_TOKEN']);
    assert.equal(after.workers['oi-acme'].secrets.CF_AI_GATEWAY_TOKEN, digest(OTHER_RUN_TOKEN));
    for (const [name, hash] of Object.entries(before.workers['oi-acme'].secrets)) {
      if (name !== 'CF_AI_GATEWAY_TOKEN') assert.equal(after.workers['oi-acme'].secrets[name], hash, `${name} unchanged`);
    }
    assert.equal(sandbox.receipt().secretEvents.at(-1).kind, 'rotate-ai-gateway-token');
    assert.ok(after.gatewayApi.probes.slice(before.gatewayApi.probes.length).every((probe) => !probe.providerCredential));
    assertNoSecretLeak(sandbox, [rejected, rotated], [OTHER_RUN_TOKEN, 'fixture-aig-token-not-on-this-account-0123']);
  });

  for (const [label, failures] of [
    ['', []],
    [', also when the create reply is lost', [{ at: 'create', when: 'after' }]],
  ]) {
    test(`a gateway deleted in the dashboard while on direct is recreated by the next switch and recorded as this installation's${label}`, async (t) => {
      const sandbox = await directInstalled(t);
      const toGateway = [...UPDATE, '--change-ai-transport', '--ai-transport', 'cloudflare-gateway'];
      const first = await sandbox.run('update', [...toGateway, '--secrets-stdin'], { input: JSON.stringify({ CF_AI_GATEWAY_TOKEN: RUN_TOKEN }), env: ADMIN_ENV });
      assert.equal(first.code, 0, first.output);
      assert.equal((await sandbox.run('update', [...UPDATE, '--change-ai-transport', '--ai-transport', 'direct'])).code, 0);
      const old = sandbox.receipt().aiGateway;
      // The operator deletes it (the installer never does).
      sandbox.update((state) => {
        delete state.gateways[KEY];
        state.gatewayApi.failures.push(...failures);
      });
      const plan = JSON.parse((await sandbox.run('plan', ['--install', 'acme', '--env', 'production', '--json'], { env: ADMIN_ENV })).stdout);

      const again = await sandbox.run('update', toGateway, { env: ADMIN_ENV });
      assert.equal(again.code, 0, again.output);
      assert.match(again.stdout, /AI Gateway oi-acme, recorded as created .*, no longer exists; a new one is created/);
      assert.match(again.stdout, /✓ gateway\.settings/);
      assert.equal(posts(sandbox).length, 2, 'one new gateway');
      const recreated = sandbox.state().gateways[KEY];
      assert.notEqual(recreated.created_at, old.createdAt);
      const receipt = sandbox.receipt();
      assert.equal(receipt.aiGateway.createdAt, recreated.created_at, 'the new gateway is the recorded one');
      assert.equal(receipt.aiGateway.attempts.length, 1, 'only the new create attempt vouches for it');
      assert.deepEqual(receipt.aiGateway.superseded.map((entry) => [entry.createdAt, entry.observedAt, entry.attempts.length]), [[old.createdAt, old.observedAt, 1]]);
      assert.equal(receipt.aiTransport, 'cloudflare-gateway');
      assert.deepEqual(receipt.lastVerification.failed, []);
      // On direct, plan listed the deleted gateway as absent, not as drift.
      assert.equal(plan.resources.at(-1).action, 'absent (a switch to cloudflare-gateway creates a new one)');
      assert.equal(plan.status, 'complete');

      // Later runs accept it as this installation's gateway.
      const update = await sandbox.run('update', UPDATE, { env: ADMIN_ENV });
      assert.equal(update.code, 0, update.output);
      const verify = await sandbox.run('verify', VERIFY, { env: ADMIN_ENV });
      assert.equal(verify.code, 0, verify.output);
      assert.match(verify.stdout, /✓ gateway\.settings/);
      assert.ok(sandbox.state().gatewayApi.calls.every((call) => ['GET', 'POST'].includes(call.method)), 'never PUT, PATCH or DELETE');
      assertNoSecretLeak(sandbox, [first, again, update, verify]);
    });
  }

  test('a resume probes the Run token it is given before uploading it, and refuses one the gateway rejects', async (t) => {
    const sandbox = await gatewaySandbox(t);
    sandbox.update((state) => { state.failures.push({ at: 'deploy', target: 'oi-acme', when: 'before' }); });
    const stopped = await sandbox.run('apply', gatewayApply(sandbox), { input: gatewaySecrets(), env: ADMIN_ENV });
    assert.equal(stopped.code, 1, stopped.output);
    let receipt = sandbox.receipt();
    assert.ok(receipt.phases['ai-gateway'] && receipt.phases.config);
    assert.equal(receipt.phases['deploy-initial'], undefined);
    const firstProbedAt = receipt.aiGateway.probedAt;
    assert.ok(firstProbedAt);

    const REJECTED = 'fixture-aig-token-not-on-this-account-0123';
    const probes = sandbox.state().gatewayApi.probes.length;
    const refused = await sandbox.run('resume', resumeArgs(sandbox), { input: gatewaySecrets({ CF_AI_GATEWAY_TOKEN: REJECTED }), env: ADMIN_ENV });
    assert.equal(refused.code, 2, refused.output);
    assert.match(refused.stderr, /the supplied Run token was not accepted by AI Gateway oi-acme as the probe expects; nothing further was changed and no secret was uploaded/);
    let state = sandbox.state();
    assert.deepEqual(state.gatewayApi.probes.slice(probes).map((probe) => [probe.tokenPresented, probe.providerCredential]), [[false, false], [true, false]]);
    assert.deepEqual(state.secretBulkCalls, []);
    assert.deepEqual(state.deploys, [], 'refused before the deploy it resumes');
    assert.equal(sandbox.receipt().aiGateway.probedAt, firstProbedAt);

    // A different token the gateway accepts is probed, then bound.
    const resumed = await sandbox.run('resume', resumeArgs(sandbox), { input: gatewaySecrets({ CF_AI_GATEWAY_TOKEN: OTHER_RUN_TOKEN }), env: ADMIN_ENV });
    assert.equal(resumed.code, 0, resumed.output);
    state = sandbox.state();
    assert.equal(state.gatewayApi.probes.filter((probe) => probe.tokenPresented).length, 3, 'apply, the refused resume and this resume each probed their token');
    assert.equal(state.workers['oi-acme'].secrets.CF_AI_GATEWAY_TOKEN, digest(OTHER_RUN_TOKEN));
    receipt = sandbox.receipt();
    assert.ok(receipt.aiGateway.probedAt > firstProbedAt);
    assert.equal(posts(sandbox).length, 1);
    assertNoSecretLeak(sandbox, [stopped, refused, resumed], [OTHER_RUN_TOKEN, REJECTED]);
  });

  test('a switch to the gateway refuses a Run token bound outside the installer, and binds a probed one once it is deleted', async (t) => {
    const sandbox = await directInstalled(t);
    const STRAY = 'fixture-aig-token-bound-out-of-band-012345';
    sandbox.update((state) => { state.workers['oi-acme'].secrets.CF_AI_GATEWAY_TOKEN = digest(STRAY); });
    const deploys = sandbox.state().deploys.length;
    const before = mutations(sandbox.state()).length;
    const toGateway = [...UPDATE, '--change-ai-transport', '--ai-transport', 'cloudflare-gateway'];
    const refused = await sandbox.run('update', toGateway, { env: ADMIN_ENV });
    assert.equal(refused.code, 2, refused.output);
    assert.match(refused.stdout, /Warning: CF_AI_GATEWAY_TOKEN is bound to oi-acme but this installer never set or probed it \(no receipt record\)/);
    assert.doesNotMatch(refused.output, /providerKeys/, 'the token is not described as a provider key');
    assert.match(refused.stderr, /CF_AI_GATEWAY_TOKEN is already bound to oi-acme without an installer record .*refusing to switch/);
    assert.match(refused.stderr, /wrangler secret delete CF_AI_GATEWAY_TOKEN --name oi-acme/);
    assert.equal(mutations(sandbox.state()).length, before, 'no gateway, upload or deploy');
    assert.equal(sandbox.state().deploys.length, deploys);
    const receipt = sandbox.receipt();
    assert.equal(receipt.aiTransport, 'direct');
    assert.equal(receipt.pendingChange, undefined);

    // Deleted deliberately: the switch asks for a token, probes it and binds it.
    sandbox.update((state) => { delete state.workers['oi-acme'].secrets.CF_AI_GATEWAY_TOKEN; });
    const switched = await sandbox.run('update', [...toGateway, '--secrets-stdin'], { input: JSON.stringify({ CF_AI_GATEWAY_TOKEN: RUN_TOKEN }), env: ADMIN_ENV });
    assert.equal(switched.code, 0, switched.output);
    assert.ok(sandbox.state().gatewayApi.probes.some((probe) => probe.tokenPresented));
    assert.equal(sandbox.state().workers['oi-acme'].secrets.CF_AI_GATEWAY_TOKEN, digest(RUN_TOKEN));
    assert.equal(sandbox.receipt().aiTransport, 'cloudflare-gateway');
    assertNoSecretLeak(sandbox, [refused, switched], [STRAY]);
  });

  test('a switch whose token upload reply was lost finishes on rerun and records when the token was bound', async (t) => {
    const sandbox = await directInstalled(t);
    sandbox.update((state) => { state.failures.push({ at: 'secret bulk', when: 'after' }); });
    const toGateway = [...UPDATE, '--change-ai-transport', '--ai-transport', 'cloudflare-gateway'];
    const lost = await sandbox.run('update', [...toGateway, '--secrets-stdin'], { input: JSON.stringify({ CF_AI_GATEWAY_TOKEN: RUN_TOKEN }), env: ADMIN_ENV });
    assert.equal(lost.code, 1, lost.output);
    const pending = sandbox.receipt().pendingChange;
    assert.ok(pending.tokenUploadAt);
    assert.equal(sandbox.receipt().secretEvents.length, 0);
    assert.equal(sandbox.state().workers['oi-acme'].secrets.CF_AI_GATEWAY_TOKEN, digest(RUN_TOKEN), 'the upload landed');

    const bulk = sandbox.state().secretBulkCalls.length;
    const finished = await sandbox.run('update', toGateway, { env: ADMIN_ENV });
    assert.equal(finished.code, 0, finished.output);
    assert.match(finished.stdout, /CF_AI_GATEWAY_TOKEN is already bound and is kept/);
    assert.equal(sandbox.state().secretBulkCalls.length, bulk, 'not uploaded again');
    const receipt = sandbox.receipt();
    assert.equal(receipt.pendingChange, undefined);
    assert.deepEqual(receipt.secretEvents.map(({ kind, names, uploaded, attemptedAt }) => ({ kind, names, uploaded, attemptedAt })), [
      { kind: 'ai-transport', names: ['CF_AI_GATEWAY_TOKEN'], uploaded: [], attemptedAt: pending.tokenUploadAt },
    ]);
    assertNoSecretLeak(sandbox, [lost, finished]);
  });

  test('plan reports a Cloudflare API outage as not checked instead of failing', async (t) => {
    const sandbox = await gatewaySandbox(t);
    sandbox.update((state) => { state.gatewayApi.failures.push({ at: 'get', status: 503 }, { at: 'get', status: 503 }, { at: 'get', status: 503 }); });
    const planArgs = ['--install', 'acme', '--env', 'production', '--provider', 'gemini', '--ai-transport', 'cloudflare-gateway', '--json'];
    const run = await sandbox.run('plan', planArgs, { env: ADMIN_ENV });
    assert.equal(run.code, 0, run.output);
    const plan = JSON.parse(run.stdout);
    assert.match(plan.resources.at(-1).action, /^not checked \(Cloudflare API GET gateway oi-acme failed: HTTP 503/);
    assert.equal(plan.resources.at(-1).exists, null);
    assertNoSecretLeak(sandbox, [run]);
  });

  test('plan lists the gateway, its vars and the Run token, and reads the gateway only with the management token', async (t) => {
    const sandbox = await gatewaySandbox(t);
    const planArgs = ['--install', 'acme', '--env', 'production', '--provider', 'gemini', '--ai-transport', 'cloudflare-gateway', '--json'];
    const withToken = JSON.parse((await sandbox.run('plan', planArgs, { env: ADMIN_ENV })).stdout);
    assert.deepEqual(withToken.resources.at(-1), { kind: 'ai-gateway', name: 'oi-acme', exists: false, owned: false, reason: null, created: false, action: 'create' });
    assert.deepEqual([withToken.vars.AI_TRANSPORT, withToken.vars.CF_AI_GATEWAY_ACCOUNT_ID, withToken.vars.CF_AI_GATEWAY_ID], ['cloudflare-gateway', ACCOUNT.id, 'oi-acme']);
    assert.deepEqual(withToken.secrets.request, ['ADMIN_PASSWORD', 'GEMINI_API_KEY', 'CF_AI_GATEWAY_TOKEN']);
    assert.match(withToken.aiGateway.join('\n'), /not covered by --jurisdiction/);
    const without = JSON.parse((await sandbox.run('plan', planArgs)).stdout);
    assert.equal(without.resources.at(-1).action, 'not checked (CF_AI_GATEWAY_ADMIN_TOKEN not set)');
    sandbox.update((state) => { state.gateways[KEY] = createdGateway({ created_at: '2026-01-01T00:00:00.000Z' }); });
    const collision = await sandbox.run('plan', planArgs, { env: ADMIN_ENV });
    assert.equal(collision.code, 2, collision.output);
    assert.deepEqual(mutations(sandbox.state()), []);
    assert.ok(sandbox.state().gatewayApi.calls.every((call) => call.method === 'GET'));
  });

  test('a gateway receipt without its gateway record is refused', async (t) => {
    const sandbox = await gatewayInstalled(t);
    const file = path.join(sandbox.installDir(), 'receipt.json');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    const { aiGateway: _gateway, ...withoutGateway } = receipt;
    for (const [broken, pattern] of [
      [withoutGateway, /aiTransport cloudflare-gateway without an aiGateway record/],
      [{ ...receipt, aiGateway: { ...receipt.aiGateway, id: 'default' } }, /aiGateway.id "default" is not the Worker name oi-acme/],
      [{ ...receipt, aiGateway: { ...receipt.aiGateway, observedAt: null } }, /the ai-gateway phase is recorded but the gateway was never observed/],
    ]) {
      writeFileSync(file, `${JSON.stringify(broken, null, 2)}\n`);
      assert.throws(() => readReceipt(file), pattern);
      const verify = await sandbox.run('verify', VERIFY);
      assert.equal(verify.code, 2, verify.output);
    }
  });
});
