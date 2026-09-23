// Read-only verification of a deployed installation through its public
// readiness endpoints plus the local installation config. It never
// authenticates, writes, dispatches work or calls a provider.
//
// The Worker is probed through its own workers.dev URL, which the deploy
// output ties to this Worker's name (model.isOwnWorkersDevHost). A custom
// origin is probed separately: nothing in these endpoints proves which
// Worker serves it.

import { setTimeout as sleep } from 'node:timers/promises';
import { isOwnWorkersDevHost } from './model.mjs';
import { buildInstallationConfig, configDrift, identityDiff, installationIdentity, readInstallationConfig } from './state.mjs';

/** Remote gates this command cannot establish (04-verification-and-cutover.md, VERIFY-04). */
export const LIMITATIONS = [
  'analysisQueue is binding presence only: it does not prove the Queue consumer is registered or consuming messages.',
  'Durable Object alarm wake-up after inactivity is not exercised.',
  'Protected logs (no invocation logs or raw participant URLs) are not inspected.',
  'Point-in-time recovery and operational restore are not rehearsed.',
  'No provider call is made: live provider compatibility needs a separately authorized smoke.',
  'Canonical-origin cookies, sign-in and the participant flow are not exercised.',
  'The deployed version and remote vars/secrets are not read back: the version shown is the last deploy this installer recorded, so a wrangler rollback or dashboard deploy is not detected.',
];

export const CUSTOM_ORIGIN_LIMITATION = 'Routing of the custom origin to this Worker is not proven: the Worker is checked through its own workers.dev URL and the origin separately, and another Worker answering the origin would look the same.';

export function limitationsFor(receipt) {
  return receipt.workersDevUrl && receipt.origin && receipt.origin !== receipt.workersDevUrl
    ? [...LIMITATIONS, CUSTOM_ORIGIN_LIMITATION]
    : [...LIMITATIONS];
}

const TERMINAL_WORKSPACE_ERRORS = [
  'workspace_identity_mismatch',
  'workspace_schema_unsupported',
  'workspace_recovery_epoch_mismatch',
];

async function getJson(origin, pathname, timeoutMs) {
  const url = new URL(pathname, origin);
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Reported as a non-JSON response below.
    }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: null, error: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

export async function probeDeployment(origin, { timeoutMs = 10_000 } = {}) {
  return {
    health: await getJson(origin, '/api/health/ready', timeoutMs),
    readiness: await getJson(origin, '/api/config/readiness', timeoutMs),
    mode: await getJson(origin, '/api/config/mode', timeoutMs),
  };
}

const safeCodes = (errors) => (Array.isArray(errors) ? errors.filter((code) => typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code)) : []);

function responseDetail(response) {
  if (response.status === 0) return response.error;
  if (response.status >= 300 && response.status < 400) return `redirected (${response.status})`;
  if (!response.body || typeof response.body !== 'object') return `HTTP ${response.status}, not JSON`;
  return `HTTP ${response.status}`;
}

/** Classify one probe: ready | held-maintenance | not-ready | unreachable. */
export function evaluateProbe(probe) {
  const { health, readiness, mode } = probe;
  const h = health.body && typeof health.body === 'object' ? health.body : {};
  const r = readiness.body && typeof readiness.body === 'object' ? readiness.body : {};
  const m = mode.body && typeof mode.body === 'object' ? mode.body : {};
  const hc = h.checks && typeof h.checks === 'object' ? h.checks : {};
  const errors = safeCodes(r.errors);
  const checks = [];
  const add = (id, ok, detail = '') => checks.push({ id, ok: Boolean(ok), detail });

  add('health.response', [200, 503].includes(health.status) && health.body, responseDetail(health));
  add('health.ready', health.status === 200 && h.ready === true, `ready=${h.ready}`);
  add('health.target', h.target === 'cloudflare', `target=${h.target}`);
  add('health.configuration', hc.configuration === true, `configuration=${hc.configuration}`);
  add('health.workspaceStore', hc.workspaceStore === true, `workspaceStore=${hc.workspaceStore}`);
  add('health.analysisQueue', hc.analysisQueue === true, `analysisQueue=${hc.analysisQueue} (binding presence only)`);
  add('health.noRedis', !('platformDatabase' in hc) && !('schemaLineage' in hc), 'no Redis checks reported');
  add('readiness.response', readiness.status === 200 && readiness.body, responseDetail(readiness));
  add('readiness.ready', r.ready === true, `ready=${r.ready}${errors.length ? `, errors ${errors.join(', ')}` : ''}`);
  add('readiness.mode', r.mode === 'standalone', `mode=${r.mode}`);
  add('readiness.analysisExecution', r.analysisExecution === 'queued-v2', `analysisExecution=${r.analysisExecution}`);
  add('readiness.noRedisErrors', !errors.some((code) => code.includes('redis')), 'no Redis error codes');
  add('mode.response', mode.status === 200 && mode.body, responseDetail(mode));
  add(
    'mode.matches',
    m.mode === 'standalone' && m.aiTransport === 'direct' && m.analysisExecution === 'queued-v2' && m.ready === r.ready,
    `mode=${m.mode}, aiTransport=${m.aiTransport}, analysisExecution=${m.analysisExecution}, ready=${m.ready}`,
  );

  let status;
  if (health.status === 0 && readiness.status === 0 && mode.status === 0) status = 'unreachable';
  else if (checks.every((check) => check.ok)) status = 'ready';
  else if (
    errors.length === 1 && errors[0] === 'workspace_maintenance'
    && r.mode === 'standalone' && r.analysisExecution === 'queued-v2' && h.target === 'cloudflare'
    && hc.configuration === true && hc.analysisQueue === true
  ) status = 'held-maintenance';
  else status = 'not-ready';
  const terminal = errors.find((code) => TERMINAL_WORKSPACE_ERRORS.includes(code)) ?? null;
  return { status, checks, errors, terminal };
}

/**
 * Poll until `accept(evaluation)` or the deadline. The first attempt is
 * immediate; the backoff doubles from 0.5 s to 10 s.
 */
export async function pollDeployment(origin, { waitSeconds, accept }) {
  const deadline = Date.now() + waitSeconds * 1000;
  let delay = 500;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const evaluation = evaluateProbe(await probeDeployment(origin));
    if (accept(evaluation) || evaluation.terminal) return { ...evaluation, attempts };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...evaluation, attempts };
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, 10_000);
  }
}

/** Local check: the installation config still carries the receipt's identity. */
export function checkInstallationConfig({ template, receipt, configPath }) {
  const actual = readInstallationConfig(configPath);
  if (!actual) return { ok: false, diffs: [`installation config ${configPath} is missing`], templateDrift: [] };
  const bootstrap = receipt.phases?.['workspace-init'] ? '' : receipt.bootstrap;
  const expected = buildInstallationConfig(template, receipt, { bootstrap });
  const owned = ['DEPLOYMENT_TARGET', 'DEPLOYMENT_MODE', 'AI_TRANSPORT', 'AI_PROVIDER', 'APP_BASE_URL', 'WORKSPACE_ID', 'WORKSPACE_JURISDICTION', 'WORKSPACE_BOOTSTRAP'];
  const pick = (identity) => ({ ...identity, vars: Object.fromEntries(owned.map((name) => [name, identity.vars[name]])) });
  const diffs = identityDiff(pick(installationIdentity(expected)), pick(installationIdentity(actual)));
  return { ok: diffs.length === 0, diffs, templateDrift: configDrift(template, actual) };
}

/** The Worker's own workers.dev URL from the receipt, or null when none is recorded. */
export function ownWorkerUrl(receipt) {
  const url = receipt.workersDevUrl;
  if (!url) return null;
  try {
    return isOwnWorkersDevHost(new URL(url).hostname, receipt.names.worker) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Probe the Worker (workers.dev) and, when it differs, the origin. Status:
 * config-mismatch, then a missing Worker URL (not-ready), then the shared
 * status of both probes; probes that disagree are not-ready.
 */
export async function verifyInstallation({ template, receipt, configPath, waitSeconds = 0, acceptHeld = false }) {
  const config = checkInstallationConfig({ template, receipt, configPath });
  const accept = (evaluation) => evaluation.status === 'ready' || (acceptHeld && evaluation.status === 'held-maintenance');
  const workerUrl = ownWorkerUrl(receipt);
  const deadline = Date.now() + waitSeconds * 1000;
  const remaining = () => Math.max(0, (deadline - Date.now()) / 1000);
  const checks = [];
  const targets = [];
  let terminal = null;
  const readinessErrors = [];

  if (!workerUrl) {
    checks.push({ id: 'worker.url', ok: false, detail: `no workers.dev URL of ${receipt.names.worker} is recorded; the origin cannot be tied to this Worker` });
  } else {
    const worker = await pollDeployment(workerUrl, { waitSeconds: remaining(), accept });
    targets.push({ role: 'worker', url: workerUrl, status: worker.status });
    checks.push(...worker.checks);
    readinessErrors.push(...worker.errors);
    terminal = worker.terminal;
  }
  if (receipt.origin && receipt.origin !== workerUrl) {
    const origin = await pollDeployment(receipt.origin, { waitSeconds: remaining(), accept });
    targets.push({ role: 'origin', url: receipt.origin, status: origin.status });
    checks.push(...origin.checks.map((check) => ({ ...check, id: `origin.${check.id}` })));
    for (const code of origin.errors) if (!readinessErrors.includes(code)) readinessErrors.push(code);
    terminal ??= origin.terminal;
    if (workerUrl) {
      const [worker] = targets;
      checks.push({
        id: 'origin.agreesWithWorker',
        ok: origin.status === worker.status,
        detail: `origin ${origin.status}, workers.dev ${worker.status}`,
      });
    }
  }

  let status;
  if (!config.ok) status = 'config-mismatch';
  else if (!workerUrl) status = 'not-ready';
  else status = targets.every((target) => target.status === targets[0].status) ? targets[0].status : 'not-ready';
  return {
    command: 'verify',
    install: receipt.install,
    env: receipt.env,
    origin: receipt.origin,
    workersDevUrl: workerUrl,
    worker: receipt.names.worker,
    status,
    ok: config.ok && Boolean(workerUrl) && accept({ status }),
    targets,
    checks,
    readinessErrors,
    terminal,
    config,
    limitations: limitationsFor(receipt),
    verifiedAt: new Date().toISOString(),
  };
}
