// Pure installer modules: names, origin rules, config generation against the
// real deploy.mjs configDrift(), secret validation and readiness evaluation.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT, readJsonc } from '../../scripts/cloudflare/lib.mjs';
import { resolveAccount } from '../../scripts/cloudflare/installer/context.mjs';
import {
  MAX_LOGIN_BODY_BYTES,
  SECRET_PLACEHOLDERS,
  deriveNames,
  loginBodyBytes,
  requiredSecretNames,
  validateInstallName,
  validateOrigin,
  workersDevUrlFromOutput,
} from '../../scripts/cloudflare/installer/model.mjs';
import {
  assertIndependent,
  epochFingerprint,
  generateEpoch,
  generateSecret,
  generateWorkspaceId,
  resolveOperatorTokenFile,
  validateSuppliedSecret,
  writeOperatorTokenFile,
} from '../../scripts/cloudflare/installer/secrets.mjs';
import { CLOCK_SKEW_MS, queueOwnership, workerOwnership } from '../../scripts/cloudflare/installer/ownership.mjs';
import { buildInstallationConfig, configDrift, newReceipt } from '../../scripts/cloudflare/installer/state.mjs';
import { parseWranglerTable } from '../../scripts/cloudflare/installer/tools.mjs';
import { evaluateProbe } from '../../scripts/cloudflare/installer/verify.mjs';
import { realConfigDrift } from './fixtures/deploy-config-drift.mjs';

const template = readJsonc(path.join(ROOT, 'wrangler.jsonc'));

function receiptFor(install, environment, overrides = {}) {
  return newReceipt({
    install,
    environment,
    accountId: 'a'.repeat(32),
    names: deriveNames(install, environment),
    workspaceId: generateWorkspaceId(),
    jurisdiction: 'eu',
    provider: 'gemini',
    origin: 'https://interviews.example.org',
    bootstrap: 'open',
    ...overrides,
  });
}

test('names are derived once per environment and staging never shares a name', () => {
  assert.deepEqual(deriveNames('acme', 'production'), {
    worker: 'oi-acme',
    queue: 'oi-acme-analysis',
    deadLetterQueue: 'oi-acme-analysis-dlq',
  });
  const staging = deriveNames('acme', 'staging');
  assert.deepEqual(staging, {
    worker: 'oi-acme-staging',
    queue: 'oi-acme-staging-analysis',
    deadLetterQueue: 'oi-acme-staging-analysis-dlq',
  });
  const longest = deriveNames('a'.repeat(24), 'staging');
  assert.ok(Object.values(longest).every((name) => name.length <= 63));
  for (const bad of ['', 'Acme', 'acme_1', '-acme', 'acme-', 'a'.repeat(25), 'acme-staging', 'ac me']) {
    assert.throws(() => validateInstallName(bad), /install/);
  }
  assert.equal(validateInstallName('lab-2'), 'lab-2');
});

test('origins follow the RT-06 rules', () => {
  assert.equal(validateOrigin('https://interviews.example.org'), 'https://interviews.example.org');
  assert.equal(validateOrigin('https://Oi-Acme.Sub.workers.dev/'), 'https://oi-acme.sub.workers.dev');
  for (const bad of [
    'http://interviews.example.org',
    'https://user:pw@interviews.example.org',
    'https://interviews.example.org/path',
    'https://interviews.example.org/?q=1',
    'https://interviews.example.org/#x',
    'https://localhost',
    'https://app.localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://intranet',
    ' https://interviews.example.org',
    '',
  ]) assert.throws(() => validateOrigin(bad), /invalid --origin/, bad);
});

test('workers.dev discovery reads only the triggers block and only this Worker\'s own URL', () => {
  const triggers = (worker, ...targets) => [`Deployed ${worker} triggers (0.50 sec)`, ...targets.map((target) => `  ${target}`), 'Current Version ID: x'].join('\n');
  assert.equal(workersDevUrlFromOutput(triggers('oi-acme', 'https://oi-acme.team-sub.workers.dev', 'https://other.team-sub.workers.dev'), 'oi-acme'), 'https://oi-acme.team-sub.workers.dev');
  assert.equal(workersDevUrlFromOutput(triggers('oi-acme', 'https://oi-acme-staging.team.workers.dev'), 'oi-acme'), null);
  assert.equal(workersDevUrlFromOutput(triggers('oi-acme', 'https://oi-acme.team.fed.workers.dev'), 'oi-acme'), 'https://oi-acme.team.fed.workers.dev');
  assert.equal(workersDevUrlFromOutput(triggers('oi-other', 'https://oi-acme.team.workers.dev'), 'oi-acme'), null);
  assert.equal(workersDevUrlFromOutput('no url here', 'oi-acme'), null);
  // A URL outside the block (e.g. the bindings table echoing APP_BASE_URL) is ignored.
  assert.equal(workersDevUrlFromOutput('Uploaded oi-acme\n  https://oi-acme.team-sub.workers.dev\n', 'oi-acme'), null);
  const withBindings = [
    'Your Worker has access to the following bindings:',
    'env.APP_BASE_URL ("https://oi-acme.other-sub.workers.dev")   Environment Variable',
    '',
    triggers('oi-acme', 'https://oi-acme.team-sub.workers.dev', 'Producer for oi-acme-analysis'),
  ].join('\n');
  assert.equal(workersDevUrlFromOutput(withBindings, 'oi-acme'), 'https://oi-acme.team-sub.workers.dev');
  assert.throws(() => workersDevUrlFromOutput(triggers('oi-acme', 'https://oi-acme.a.workers.dev', 'https://oi-acme.b.workers.dev'), 'oi-acme'), /more than one/);
});

test('wrangler table output parses by header', () => {
  const text = [
    '┌────┬──────────────────┬────────────┐',
    '│ id │ name             │ created_on │',
    '├────┼──────────────────┼────────────┤',
    '│ q1 │ oi-acme-analysis │ 2026-09-01 │',
    '│ q2 │ other            │ 2026-09-02 │',
    '└────┴──────────────────┴────────────┘',
  ].join('\n');
  assert.deepEqual(parseWranglerTable(text).map((row) => row.name), ['oi-acme-analysis', 'other']);
  assert.deepEqual(parseWranglerTable('┌┐\n└┘'), []);
  assert.deepEqual(parseWranglerTable('\u001b[90m│\u001b[39m id \u001b[90m│\u001b[39m name \u001b[90m│\u001b[39m\n│ x │ y │').map((row) => row.name), ['y']);
});

test('generated installation configs pass the real deploy.mjs configDrift()', () => {
  for (const environment of ['production', 'staging']) {
    for (const bootstrap of ['open', 'recovery', '']) {
      const receipt = receiptFor('acme', environment);
      const config = buildInstallationConfig(template, receipt, { bootstrap });
      assert.deepEqual(realConfigDrift(template, config), []);
      assert.equal(config.name, receipt.names.worker);
      assert.equal(config.account_id, receipt.accountId);
      assert.equal(config.$schema, undefined);
      assert.equal(config.vars.WORKSPACE_BOOTSTRAP, bootstrap);
      assert.equal(config.vars.WORKSPACE_ID, receipt.workspaceId);
      assert.equal(config.vars.WORKSPACE_JURISDICTION, 'eu');
      assert.equal(config.vars.DEPLOYMENT_TARGET, 'cloudflare');
      assert.deepEqual(config.queues.producers.map((entry) => entry.queue), [receipt.names.queue]);
      assert.deepEqual(config.queues.consumers.map((entry) => [entry.queue, entry.dead_letter_queue]), [[receipt.names.queue, receipt.names.deadLetterQueue]]);
      // Everything that is not installation-owned is the template's.
      assert.deepEqual(config.durable_objects, template.durable_objects);
      assert.deepEqual(config.migrations, template.migrations);
      assert.deepEqual(config.observability, template.observability);
    }
  }
  const none = buildInstallationConfig(template, receiptFor('acme', 'production', { jurisdiction: 'none' }), { bootstrap: '' });
  assert.equal(none.vars.WORKSPACE_JURISDICTION, '');
});

test('the installer copy of configDrift() agrees with deploy.mjs', () => {
  const config = buildInstallationConfig(template, receiptFor('acme', 'production'), { bootstrap: '' });
  const variants = [
    config,
    { ...config, compatibility_date: '2000-01-01' },
    { ...config, main: 'elsewhere.ts' },
    { ...config, vars: { ...config.vars, EXTRA: 'x' } },
    { ...config, queues: { ...config.queues, consumers: [{ ...config.queues.consumers[0], max_retries: 9 }] } },
    { ...config, durable_objects: { bindings: [] } },
    { ...config, routes: [{ pattern: 'interviews.example.org', custom_domain: true }] },
  ];
  for (const variant of variants) assert.deepEqual(configDrift(template, variant), realConfigDrift(template, variant));
});

test('supplied credentials are validated without echoing values', () => {
  for (const [name, value, pattern] of [
    ['ADMIN_PASSWORD', '', /blank/],
    ['ADMIN_PASSWORD', 'changeme-changeme-changeme', /placeholder/],
    ['ADMIN_PASSWORD', 'your-admin-password-here', /placeholder/],
    ['ADMIN_PASSWORD', 'short-password1', /at least 16/],
    ['ADMIN_PASSWORD', ' leading-space-password', /whitespace/],
    ['GEMINI_API_KEY', 'example-key', /placeholder/],
    ['GEMINI_API_KEY', 'line\nbreak-key-value', /control/],
  ]) {
    assert.throws(() => validateSuppliedSecret(name, value), (error) => pattern.test(error.message) && (!value || !error.message.includes(value)));
  }
  assert.equal(validateSuppliedSecret('ADMIN_PASSWORD', 'a-long-enough-password'), 'a-long-enough-password');
  assert.throws(() => assertIndependent({ ADMIN_PASSWORD: 'same-value-0123456789', GEMINI_API_KEY: 'same-value-0123456789' }), /reuses the value of ADMIN_PASSWORD/);
});

test('the installer password cap is the Cloudflare sign-in body cap', () => {
  // The route refuses a larger body with 413 before it compares the password.
  const definitions = [];
  for (const entry of readdirSync(path.join(ROOT, 'src'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const source = readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
    for (const match of source.matchAll(/\bMAX_CLOUDFLARE_LOGIN_BODY_BYTES\s*(?::\s*number\s*)?=\s*([\d_]+)/g)) {
      definitions.push(Number(match[1].replaceAll('_', '')));
    }
  }
  assert.deepEqual(definitions, [MAX_LOGIN_BODY_BYTES]);
  // The Login page and the operator CLI send exactly this body.
  for (const file of ['src/components/Login.tsx', 'scripts/cloudflare/operator.mjs']) {
    assert.match(readFileSync(path.join(ROOT, file), 'utf8'), /JSON\.stringify\(\{ password(?:: [\w.]+)? \}\)/, file);
  }
});

test('an ADMIN_PASSWORD whose sign-in body exceeds 1 KiB is refused, measured in UTF-8 after JSON escaping', () => {
  for (const [label, fits, overflows] of [
    ['ASCII', 'A'.repeat(1009), 'A'.repeat(1010)],
    ['3-byte characters', '\u20ac'.repeat(336), '\u20ac'.repeat(337)],
    ['characters JSON escapes', '"'.repeat(504), '"'.repeat(505)],
    ['lone surrogates (escaped as \\uXXXX)', '\ud800'.repeat(168), '\ud800'.repeat(169)],
  ]) {
    assert.ok(loginBodyBytes(fits) <= MAX_LOGIN_BODY_BYTES, label);
    assert.equal(validateSuppliedSecret('ADMIN_PASSWORD', fits), fits, label);
    assert.ok(loginBodyBytes(overflows) > MAX_LOGIN_BODY_BYTES, label);
    assert.throws(
      () => validateSuppliedSecret('ADMIN_PASSWORD', overflows),
      (error) => /ADMIN_PASSWORD is too long: .* at most 1024/.test(error.message) && !error.message.includes(overflows),
      label,
    );
  }
  assert.equal(loginBodyBytes('A'.repeat(1009)), 1024);
  // Other credentials keep the 4096-character limit.
  assert.equal(validateSuppliedSecret('GEMINI_API_KEY', 'k'.repeat(2000)), 'k'.repeat(2000));
});

test('the placeholder pattern matches check-setup.mjs and hostedConfig.ts', () => {
  const literal = SECRET_PLACEHOLDERS.toString();
  for (const file of ['scripts/check-setup.mjs', 'src/lib/hostedConfig.ts']) {
    assert.ok(readFileSync(path.join(ROOT, file), 'utf8').includes(`SECRET_PLACEHOLDERS = ${literal}`), file);
  }
});

test('generated identities and secrets have the required shapes', () => {
  assert.match(generateWorkspaceId(), /^ws_[a-f0-9]{32}$/);
  const epoch = generateEpoch();
  assert.match(epoch, /^ep_[a-f0-9]{32}$/);
  assert.match(epochFingerprint(epoch), /^sha256:[a-f0-9]{16}$/);
  assert.ok(!epochFingerprint(epoch).includes(epoch.slice(3)));
  const secrets = Array.from({ length: 50 }, generateSecret);
  assert.equal(new Set(secrets).size, 50);
  for (const secret of secrets) assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(requiredSecretNames(['claude']).sort(), [
    'ADMIN_PASSWORD',
    'ANALYSIS_RECOVERY_EPOCH',
    'ANTHROPIC_API_KEY',
    'OPERATOR_TOKEN',
    'PARTICIPANT_TOKEN_SECRET',
    'RATE_LIMIT_SALT',
    'SESSION_SECRET',
  ]);
  assert.deepEqual(requiredSecretNames(['gemini', 'openai', 'openrouter']).slice(-3), ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']);
});

test('the operator token file must live outside the repository and state directory', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oi-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state');
  assert.throws(() => resolveOperatorTokenFile(path.join(ROOT, 'token.txt'), { root: ROOT, stateDir }), /outside the repository/);
  assert.throws(() => resolveOperatorTokenFile(path.join(ROOT, 'cloudflare', 'token.txt'), { root: ROOT, stateDir }), /outside the repository/);
  assert.throws(() => resolveOperatorTokenFile(path.join(dir, 'missing', 'token.txt'), { root: ROOT, stateDir }), /does not exist/);
  assert.throws(() => resolveOperatorTokenFile(path.join(dir, 'token.txt'), { root: ROOT, stateDir: dir }), /state directory/);
  const existing = path.join(dir, 'existing.txt');
  writeFileSync(existing, 'x');
  assert.throws(() => resolveOperatorTokenFile(existing, { root: ROOT, stateDir }), /already exists/);
  assert.deepEqual(resolveOperatorTokenFile(existing, { root: ROOT, stateDir, previousFile: existing }), { file: existing, overwrite: true });
  assert.deepEqual(resolveOperatorTokenFile(path.join(dir, 'new.txt'), { root: ROOT, stateDir }), { file: path.join(dir, 'new.txt'), overwrite: false });
  const link = path.join(dir, 'link.txt');
  symlinkSync(existing, link);
  assert.throws(() => resolveOperatorTokenFile(link, { root: ROOT, stateDir, previousFile: link }), /not a regular file/);
  const dangling = path.join(dir, 'dangling.txt');
  symlinkSync(path.join(dir, 'nowhere.txt'), dangling);
  assert.throws(() => resolveOperatorTokenFile(dangling, { root: ROOT, stateDir }), /not a regular file/);
  const shared = path.join(dir, 'shared');
  mkdirSync(shared);
  chmodSync(shared, 0o777);
  assert.throws(() => resolveOperatorTokenFile(path.join(shared, 'token.txt'), { root: ROOT, stateDir }), /writable by other users without the sticky bit/);
  chmodSync(shared, 0o1777);
  assert.equal(resolveOperatorTokenFile(path.join(shared, 'token.txt'), { root: ROOT, stateDir }).overwrite, false);
});

test('the operator token write never follows a link planted after the path was checked', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oi-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const victim = path.join(dir, 'victim.txt');
  writeFileSync(victim, 'original\n');

  // Checked as new, then replaced by a symlink before the write.
  const fresh = path.join(dir, 'fresh.txt');
  const checked = resolveOperatorTokenFile(fresh, { root: ROOT, stateDir: path.join(dir, 'state') });
  symlinkSync(victim, fresh);
  assert.throws(() => writeOperatorTokenFile(checked, 'token-value'), /appeared or became a link/);
  assert.equal(readFileSync(victim, 'utf8'), 'original\n');

  // Checked as new, then created by someone else before the write.
  const raced = path.join(dir, 'raced.txt');
  const racedCheck = resolveOperatorTokenFile(raced, { root: ROOT, stateDir: path.join(dir, 'state') });
  writeFileSync(raced, 'planted\n');
  assert.throws(() => writeOperatorTokenFile(racedCheck, 'token-value'), /appeared or became a link/);
  assert.equal(readFileSync(raced, 'utf8'), 'planted\n');

  // An overwrite target swapped for a symlink.
  const previous = path.join(dir, 'previous.txt');
  writeFileSync(previous, 'old-token\n', { mode: 0o600 });
  const overwrite = resolveOperatorTokenFile(previous, { root: ROOT, stateDir: path.join(dir, 'state'), previousFile: previous });
  rmSync(previous);
  symlinkSync(victim, previous);
  assert.throws(() => writeOperatorTokenFile(overwrite, 'token-value'), /no longer a regular file/);
  assert.equal(readFileSync(victim, 'utf8'), 'original\n');

  // The normal paths still work, with mode 0600.
  const ok = path.join(dir, 'ok.txt');
  writeOperatorTokenFile(resolveOperatorTokenFile(ok, { root: ROOT, stateDir: path.join(dir, 'state') }), 'token-one');
  assert.equal(readFileSync(ok, 'utf8'), 'token-one\n');
  assert.equal(statSync(ok).mode & 0o777, 0o600);
  writeOperatorTokenFile(resolveOperatorTokenFile(ok, { root: ROOT, stateDir: path.join(dir, 'state'), previousFile: ok }), 'token-two');
  assert.equal(readFileSync(ok, 'utf8'), 'token-two\n');
});

test('account selection is explicit and consistent', () => {
  const one = { accounts: [{ id: 'a'.repeat(32), name: 'A' }] };
  const two = { accounts: [{ id: 'a'.repeat(32), name: 'A' }, { id: 'b'.repeat(32), name: 'B' }] };
  assert.equal(resolveAccount(one, {}).id, 'a'.repeat(32));
  assert.throws(() => resolveAccount(two, {}), /choose one with --account-id/);
  assert.equal(resolveAccount(two, { requested: 'b'.repeat(32) }).id, 'b'.repeat(32));
  assert.throws(() => resolveAccount(two, { requested: 'b'.repeat(32), receiptAccount: 'a'.repeat(32) }), /differs from the receipt/);
  assert.throws(() => resolveAccount(two, { receiptAccount: 'a'.repeat(32), envAccount: 'b'.repeat(32) }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.throws(() => resolveAccount(one, { requested: 'c'.repeat(32) }), /not accessible/);
});

test('readiness evaluation distinguishes ready, held, not-ready and Redis leakage', () => {
  const ok = (body, status = 200) => ({ status, body });
  const view = (extra = {}) => ({ mode: 'standalone', aiTransport: 'direct', ready: true, errors: [], analysisExecution: 'queued-v2', ...extra });
  const health = (extra = {}, status = 200) => ok({ ready: status === 200, target: 'cloudflare', checks: { configuration: true, workspaceStore: true, analysisQueue: true, ...extra } }, status);
  assert.equal(evaluateProbe({ health: health(), readiness: ok(view()), mode: ok(view()) }).status, 'ready');
  const held = view({ ready: false, errors: ['workspace_maintenance'] });
  assert.equal(evaluateProbe({ health: health({ workspaceStore: false }, 503), readiness: ok(held), mode: ok(held) }).status, 'held-maintenance');
  const notReady = view({ ready: false, errors: ['missing_app_base_url'] });
  const evaluation = evaluateProbe({ health: health({ configuration: false }, 503), readiness: ok(notReady), mode: ok(notReady) });
  assert.equal(evaluation.status, 'not-ready');
  assert.deepEqual(evaluation.errors, ['missing_app_base_url']);
  const redis = evaluateProbe({ health: health({ platformDatabase: true }), readiness: ok(view()), mode: ok(view()) });
  assert.equal(redis.status, 'not-ready');
  assert.equal(redis.checks.find((check) => check.id === 'health.noRedis').ok, false);
  const redisErrors = view({ ready: false, errors: ['missing_standalone_redis_url'] });
  assert.equal(evaluateProbe({ health: health({}, 503), readiness: ok(redisErrors), mode: ok(redisErrors) }).checks.find((check) => check.id === 'readiness.noRedisErrors').ok, false);
  const down = { status: 0, body: null, error: 'unreachable' };
  assert.equal(evaluateProbe({ health: down, readiness: down, mode: down }).status, 'unreachable');
  const terminal = view({ ready: false, errors: ['workspace_identity_mismatch'] });
  assert.equal(evaluateProbe({ health: health({ workspaceStore: false }, 503), readiness: ok(terminal), mode: ok(terminal) }).terminal, 'workspace_identity_mismatch');
  // A version without its configuration yet settles by itself: not terminal.
  const unconfigured = view({ ready: false, errors: ['workspace_unconfigured'] });
  const settling = evaluateProbe({ health: health({ workspaceStore: false }, 503), readiness: ok(unconfigured), mode: ok(unconfigured) });
  assert.equal(settling.status, 'not-ready');
  assert.equal(settling.terminal, null);

  // Each identity claim is checked on its own: a ready Node, hosted or
  // synchronous deployment is not this installation.
  const failed = (probe) => evaluateProbe(probe).checks.filter((check) => !check.ok).map((check) => check.id);
  const nodeHealth = ok({ ready: true, target: 'node', checks: { configuration: true, workspaceStore: true, analysisQueue: true } });
  assert.deepEqual(failed({ health: nodeHealth, readiness: ok(view()), mode: ok(view()) }), ['health.target']);
  const noTarget = ok({ ready: true, checks: { configuration: true, workspaceStore: true, analysisQueue: true } });
  assert.deepEqual(failed({ health: noTarget, readiness: ok(view()), mode: ok(view()) }), ['health.target']);
  assert.deepEqual(failed({ health: health(), readiness: ok(view({ mode: 'hosted' })), mode: ok(view()) }), ['readiness.mode']);
  assert.deepEqual(failed({ health: health(), readiness: ok(view()), mode: ok(view({ mode: 'hosted' })) }), ['mode.matches']);
  for (const execution of ['synchronous', null, undefined]) {
    assert.deepEqual(failed({ health: health(), readiness: ok(view({ analysisExecution: execution })), mode: ok(view()) }), ['readiness.analysisExecution'], String(execution));
    assert.deepEqual(failed({ health: health(), readiness: ok(view()), mode: ok(view({ analysisExecution: execution })) }), ['mode.matches'], String(execution));
  }
  assert.deepEqual(failed({ health: health(), readiness: ok(view()), mode: ok(view({ aiTransport: 'gateway' })) }), ['mode.matches']);
  // Readiness and mode must agree about readiness.
  assert.deepEqual(failed({ health: health(), readiness: ok(view()), mode: ok(view({ ready: false })) }), ['mode.matches']);
  for (const probe of [
    { health: nodeHealth, readiness: ok(view()), mode: ok(view()) },
    { health: health(), readiness: ok(view({ mode: 'hosted' })), mode: ok(view({ mode: 'hosted' })) },
    { health: health(), readiness: ok(view({ analysisExecution: 'synchronous' })), mode: ok(view({ analysisExecution: 'synchronous' })) },
  ]) assert.equal(evaluateProbe(probe).status, 'not-ready');
  // A held workspace on the wrong target or mode is not "held", it is not ready.
  assert.equal(evaluateProbe({ health: ok({ ready: false, target: 'node', checks: { configuration: true, workspaceStore: false, analysisQueue: true } }, 503), readiness: ok(held), mode: ok(held) }).status, 'not-ready');
});

test('a held workspace is held-maintenance only when the mode endpoint reports the expected installation', () => {
  const ok = (body, status = 200) => ({ status, body });
  const view = (extra = {}) => ({ mode: 'standalone', aiTransport: 'direct', ready: true, errors: [], analysisExecution: 'queued-v2', ...extra });
  const heldHealth = ok({ ready: false, target: 'cloudflare', checks: { configuration: true, workspaceStore: false, analysisQueue: true } }, 503);
  const heldReadiness = (extra = {}) => ok(view({ ready: false, errors: ['workspace_maintenance'], ...extra }));
  // /api/config/mode reports configuration readiness only, so on the real
  // Worker it says ready while /api/config/readiness reports the hold.
  const heldMode = (extra = {}) => ok(view(extra));
  const status = (probe, options) => evaluateProbe(probe, options).status;

  for (const aiTransport of ['direct', 'cloudflare-gateway']) {
    assert.equal(status({ health: heldHealth, readiness: heldReadiness({ aiTransport }), mode: heldMode({ aiTransport }) }, { aiTransport }), 'held-maintenance', aiTransport);
    assert.equal(status({ health: heldHealth, readiness: heldReadiness({ aiTransport }), mode: heldMode({ aiTransport, ready: false, errors: ['workspace_maintenance'] }) }, { aiTransport }), 'held-maintenance', aiTransport);
  }
  // A transport the installation does not expect is not ready, held or not (RT-11).
  for (const [expected, reported] of [['direct', 'cloudflare-gateway'], ['cloudflare-gateway', 'direct'], ['direct', null], ['direct', 'gateway']]) {
    const held = { health: heldHealth, readiness: heldReadiness({ aiTransport: reported }), mode: heldMode({ aiTransport: reported }) };
    assert.equal(status(held, { aiTransport: expected }), 'not-ready', `held: expected ${expected}, reported ${reported}`);
    const ready = { health: ok({ ready: true, target: 'cloudflare', checks: { configuration: true, workspaceStore: true, analysisQueue: true } }), readiness: ok(view({ aiTransport: reported })), mode: ok(view({ aiTransport: reported })) };
    assert.equal(status(ready, { aiTransport: expected }), 'not-ready', `ready: expected ${expected}, reported ${reported}`);
  }
  // So is any other mode mismatch reported by the mode endpoint, or no mode answer at all.
  for (const extra of [{ mode: 'hosted' }, { analysisExecution: 'synchronous' }, { analysisExecution: null }]) {
    assert.equal(status({ health: heldHealth, readiness: heldReadiness(), mode: heldMode(extra) }), 'not-ready', JSON.stringify(extra));
  }
  assert.equal(status({ health: heldHealth, readiness: heldReadiness(), mode: { status: 0, body: null, error: 'unreachable' } }), 'not-ready');
  assert.equal(status({ health: heldHealth, readiness: heldReadiness(), mode: ok({ error: 'not found' }, 404) }), 'not-ready');
});

test('ownership evidence: a receipt attempt alone never adopts an existing resource', () => {
  const at = '2026-09-23T10:00:00.000Z';
  const plus = (ms) => new Date(Date.parse(at) + ms).toISOString();
  const attempt = { kind: 'queue', attempts: [{ at }] };
  assert.equal(queueOwnership({ id: 'q', created_on: plus(3_000) }, attempt).owned, true);
  assert.equal(queueOwnership({ id: 'q', created_on: plus(-CLOCK_SKEW_MS + 1_000) }, attempt).owned, true, 'clock skew is tolerated');
  assert.equal(queueOwnership({ id: 'q', created_on: '2026-01-01T00:00:00Z' }, attempt).owned, false, 'older than the attempt');
  assert.equal(queueOwnership({ id: 'q', created_on: plus(60 * 60_000) }, attempt).owned, false, 'long after the attempt');
  assert.equal(queueOwnership({ id: 'q', created_on: 'not a date' }, attempt).owned, false);
  assert.equal(queueOwnership({ id: 'q', created_on: plus(1_000) }, undefined).owned, false, 'no record');
  assert.equal(queueOwnership({ id: 'q', created_on: plus(1_000) }, { kind: 'queue', attempts: [] }).owned, false);
  assert.equal(queueOwnership({ id: 'q', created_on: '2020-01-01' }, { kind: 'queue', id: 'q', attempts: [] }).owned, true, 'recorded id');
  assert.match(queueOwnership({ id: 'other', created_on: plus(1_000) }, { kind: 'queue', id: 'q', attempts: [{ at }] }).reason, /differs from the recorded/);

  const worker = { kind: 'worker', attempts: [{ at, commit: 'c'.repeat(40) }] };
  const deployment = (created, message = `openinterviewer ${'c'.repeat(12)}`) => ({ created_on: created, annotations: message ? { 'workers/message': message } : {} });
  assert.equal(workerOwnership([deployment(plus(30_000))], worker).owned, true);
  assert.equal(workerOwnership([deployment(plus(30_000), null)], worker).owned, true, 'message annotation absent on the deployment');
  assert.equal(workerOwnership([deployment('2026-01-01T00:00:00Z')], worker).owned, false, 'predates the attempt');
  assert.equal(workerOwnership([deployment('2026-01-01T00:00:00Z'), deployment(plus(30_000))], worker).owned, false, 'an older foreign deployment');
  assert.equal(workerOwnership([deployment(plus(30_000), 'hello from the dashboard')], worker).owned, false, 'foreign message');
  assert.equal(workerOwnership([deployment(plus(30_000), `openinterviewer ${'d'.repeat(12)}`)], worker).owned, false, 'another commit');
  assert.equal(workerOwnership([], worker).owned, false, 'no deployments');
  assert.equal(workerOwnership([deployment(plus(30_000))], undefined).owned, false, 'no record');
  assert.equal(workerOwnership([deployment('2020-01-01')], { ...worker, observedAt: at }).owned, true, 'observed after a completed deploy');
});
