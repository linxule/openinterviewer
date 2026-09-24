// The installation's Cloudflare AI Gateway (RT-11, SETUP-08, gw-final D7 and
// D13). The installer creates one gateway per installation, named after its
// Worker, through the Cloudflare API with an operator-supplied management
// token (CF_AI_GATEWAY_ADMIN_TOKEN) that lives only in this process: it is
// never bound, passed to a child process, written or logged. It adopts an
// existing gateway only on recorded evidence (ownership.gatewayOwnership),
// refuses one whose settings break the policy instead of changing them, never
// uses the account's `default` gateway, and never deletes a gateway.
//
// The Run token the Worker sends (CF_AI_GATEWAY_TOKEN) is probed without a
// provider call: no provider credential is ever sent, so a request cannot
// reach a provider as an authenticated, billable call.
//
// Every HTTP call goes through an injectable `fetch` (GatewayApi,
// probeGateway), so tests answer them from a local fake; response bodies are
// never logged, only status codes and numeric error codes.

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  GATEWAY_ADMIN_TOKEN_ENV,
  GATEWAY_ID_PATTERN,
  InstallerError,
  REFUSED,
  gatewayIdFor,
} from './model.mjs';
import { GATEWAY_CALL_MS, gatewayOwnership } from './ownership.mjs';
import { newGatewayRecord } from './state.mjs';

export const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';
/** The only AI Gateway host (src/lib/providers/endpoint.ts CF_AI_GATEWAY_ORIGIN). */
export const GATEWAY_ORIGIN = 'https://gateway.ai.cloudflare.com';
export const GATEWAY_API_TIMEOUT_MS = GATEWAY_CALL_MS;
/** Reads are retried on a network failure, 429 or 5xx; writes never are. */
export const GATEWAY_GET_ATTEMPTS = 3;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const refuse = (message, hints = []) => new InstallerError(message, { exitCode: REFUSED, hints });
const now = () => new Date().toISOString();

/**
 * The settings a new gateway is created with (D7): authentication on, logs
 * off, caching off, rate limiting 0, provider credentials required. Retries,
 * DLP, Guardrails, Logpush, OTel, `store_id` and `zdr` are left unset.
 */
export const GATEWAY_CREATE_SETTINGS = Object.freeze({
  authentication: true,
  collect_logs: false,
  cache_ttl: 0,
  cache_invalidate_on_update: false,
  rate_limiting_interval: 0,
  rate_limiting_limit: 0,
  byok_only: true,
});

export function gatewayCreateBody(id) {
  return { id, ...GATEWAY_CREATE_SETTINGS };
}

/**
 * The cf-aig-* headers the Worker sends on every gateway request
 * (src/lib/providers/endpoint.ts cfAigRequestHeaders; a unit test keeps the
 * two equal). The probes send the same set, without the authorization for the
 * unauthenticated one, so a probe can neither be logged, cached, retried nor
 * billed to Cloudflare credentials.
 */
export function gatewayRequestHeaders(runToken) {
  return {
    ...(runToken ? { 'cf-aig-authorization': `Bearer ${runToken}` } : {}),
    'cf-aig-collect-log': 'false',
    'cf-aig-collect-log-payload': 'false',
    'cf-aig-skip-cache': 'true',
    'cf-aig-max-attempts': '1',
    'cf-aig-no-wholesale': 'true',
  };
}

// ---------- the management token ----------

/**
 * CF_AI_GATEWAY_ADMIN_TOKEN from this process's environment, registered so no
 * file or report can contain it, or null when unset. tools.toolEnv() is an
 * allowlist, so no child process ever receives it.
 */
export function readAdminToken(registry, env = process.env) {
  const value = env[GATEWAY_ADMIN_TOKEN_ENV];
  if (value === undefined || value === '') return null;
  if (value.trim() !== value || /\s/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw refuse(`${GATEWAY_ADMIN_TOKEN_ENV} contains whitespace or control characters`);
  }
  registry.add(value);
  return value;
}

export function adminTokenRequired(why) {
  return refuse(`${why} needs ${GATEWAY_ADMIN_TOKEN_ENV}: a Cloudflare API token with AI Gateway Read and Edit on the installation's account`, [
    `Provide it in this process's environment only, for example: op run --env-file <file with ${GATEWAY_ADMIN_TOKEN_ENV}=op://…> -- npm run setup:cloudflare -- …`,
    'It is never bound to the Worker, passed to wrangler or deploy.mjs, written or printed.',
  ]);
}

// ---------- HTTP ----------

async function readBounded(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.subarray(0, MAX_RESPONSE_BYTES).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Numeric Cloudflare API error codes only; messages are never echoed. */
function errorCodes(json) {
  const codes = Array.isArray(json?.errors) ? json.errors.map((entry) => entry?.code).filter((code) => Number.isInteger(code)) : [];
  return codes.length > 0 ? ` (Cloudflare error code${codes.length === 1 ? '' : 's'} ${codes.join(', ')})` : '';
}

const defaultFetch = (...args) => globalThis.fetch(...args);

/**
 * Cloudflare API client for `/accounts/{id}/ai-gateway/gateways`. Only GET
 * and POST are implemented: the installer never updates (PUT) or deletes a
 * gateway.
 */
export class GatewayApi {
  #token;

  constructor({ accountId, adminToken, fetchImpl = defaultFetch, timeoutMs = GATEWAY_API_TIMEOUT_MS, retryDelayMs = 1000 }) {
    this.accountId = accountId;
    this.#token = adminToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retryDelayMs = retryDelayMs;
  }

  #url(suffix) {
    return `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${this.accountId}/ai-gateway/gateways${suffix}`;
  }

  async #call(method, suffix, body) {
    try {
      const response = await this.fetchImpl(this.#url(suffix), {
        method,
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { status: response.status, json: await readBounded(response) };
    } catch (error) {
      return { status: 0, json: null, failure: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }

  #failure(method, label, result) {
    const hints = [401, 403].includes(result.status)
      ? [`${GATEWAY_ADMIN_TOKEN_ENV} must be valid for account ${this.accountId} with AI Gateway Read and Edit.`]
      : [];
    const what = result.status === 0 ? result.failure : `HTTP ${result.status}${errorCodes(result.json)}`;
    return new InstallerError(`Cloudflare API ${method} ${label} failed: ${what}`, { hints });
  }

  async #get(suffix, label) {
    let result;
    for (let attempt = 1; attempt <= GATEWAY_GET_ATTEMPTS; attempt += 1) {
      result = await this.#call('GET', suffix);
      const transient = result.status === 0 || result.status === 429 || result.status >= 500;
      if (!transient || attempt === GATEWAY_GET_ATTEMPTS) break;
      await sleep(this.retryDelayMs * attempt);
    }
    if (result.status === 404) return { found: false };
    if (result.status !== 200 || result.json?.success !== true) throw this.#failure('GET', label, result);
    return { found: true, json: result.json };
  }

  /** The gateway, or null when the API answers 404 (any other failure throws). */
  async getGateway(id) {
    const read = await this.#get(`/${encodeURIComponent(id)}`, `gateway ${id}`);
    if (!read.found) return null;
    const gateway = read.json.result;
    if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) {
      throw new InstallerError(`Cloudflare API GET gateway ${id} returned no gateway object`);
    }
    return gateway;
  }

  /**
   * One create, never retried: a lost reply is settled by reading the gateway
   * back and the recorded attempt window. `nameTaken` (HTTP 409) means this
   * call created nothing.
   */
  async createGateway(body) {
    const result = await this.#call('POST', '', body);
    if (result.status === 200 && result.json?.success === true) return { ok: true, nameTaken: false, error: null };
    return { ok: false, nameTaken: result.status === 409, error: this.#failure('POST', `gateway ${body.id}`, result) };
  }

  /**
   * How many logs the gateway stores, from the listing's `result_info.total_count`,
   * or null when the API does not report a count.
   */
  async logCount(id) {
    const read = await this.#get(`/${encodeURIComponent(id)}/logs?per_page=1`, `logs of gateway ${id}`);
    if (!read.found) return null;
    const total = read.json.result_info?.total_count;
    return Number.isInteger(total) && total >= 0 ? total : null;
  }
}

// ---------- settings policy ----------

/** Fields of the gateway object in the Cloudflare API reference (September 2026). */
export const KNOWN_GATEWAY_FIELDS = [
  'id', 'created_at', 'modified_at', 'authentication', 'byok_only', 'cache_invalidate_on_update', 'cache_ttl',
  'collect_logs', 'dlp', 'guardrails', 'is_default', 'log_classification', 'log_management', 'log_management_strategy',
  'logpush', 'logpush_public_key', 'otel', 'rate_limiting_interval', 'rate_limiting_limit', 'rate_limiting_technique',
  'retry_backoff', 'retry_delay', 'retry_max_attempts', 'spend_limits', 'store_id', 'stripe', 'workers_ai_billing_mode',
  'zdr',
];

/** The fields the policy reads; their values make up the recorded settings digest. */
const POLICY_FIELDS = [
  'authentication', 'byok_only', 'cache_ttl', 'collect_logs', 'dlp', 'guardrails', 'is_default', 'logpush', 'otel',
  'rate_limiting_interval', 'rate_limiting_limit', 'retry_max_attempts', 'spend_limits', 'store_id',
];

const unset = (value) => value === undefined || value === null;
const show = (value) => JSON.stringify(value) ?? 'absent';

function hasContent(value) {
  if (unset(value)) return false;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === 'object') return Object.values(value).some(hasContent);
  return value !== '' && value !== false;
}

/**
 * The installation policy for a gateway (D7). `refusals` must be empty for the
 * installer to use it; `warnings` are reported. The installer never corrects
 * a refused setting itself.
 *
 * Refused: another id or the default gateway; authentication off; logging on;
 * provider credentials not required; caching on; gateway retries set (a
 * `retry_max_attempts` other than absent, null or 1); Logpush on; DLP,
 * Guardrails or OTel configured; a Secrets Store attached.
 * Warned: non-zero rate limiting, spend limits, Stripe usage events, log
 * classification, and fields this installer does not know.
 */
export function gatewaySettingsPolicy(gateway, { id }) {
  const refusals = [];
  const warnings = [];
  if (gateway.id !== id) refusals.push(`id is ${show(gateway.id)}, not ${id}`);
  if (gateway.id === 'default' || gateway.is_default === true) refusals.push('it is the account\'s default gateway');
  if (gateway.authentication !== true) refusals.push(`authentication is ${show(gateway.authentication)}: requests must need the Run token`);
  if (gateway.collect_logs !== false) refusals.push(`collect_logs is ${show(gateway.collect_logs)}: logging must be off`);
  if (gateway.byok_only !== true) refusals.push(`byok_only is ${show(gateway.byok_only)}: provider credentials must be required (no Unified Billing)`);
  if (!(unset(gateway.cache_ttl) || gateway.cache_ttl === 0)) refusals.push(`cache_ttl is ${show(gateway.cache_ttl)}: caching must be off`);
  if (!(unset(gateway.retry_max_attempts) || gateway.retry_max_attempts === 1)) {
    refusals.push(`retry_max_attempts is ${show(gateway.retry_max_attempts)}: gateway retries must stay unset`);
  }
  if (!(unset(gateway.logpush) || gateway.logpush === false)) refusals.push(`logpush is ${show(gateway.logpush)}: Logpush must be off`);
  const dlp = gateway.dlp;
  if (!(unset(dlp) || (typeof dlp === 'object' && !Array.isArray(dlp) && dlp.enabled === false))) {
    refusals.push('DLP is configured: it must be absent or disabled');
  }
  if (hasContent(gateway.guardrails)) refusals.push('Guardrails are configured: they must be absent');
  if (hasContent(gateway.otel)) refusals.push('OTel export is configured: it must be absent');
  if (!(unset(gateway.store_id) || gateway.store_id === '')) refusals.push('a Secrets Store (store_id) is attached: stored provider keys are not used');

  for (const field of ['rate_limiting_interval', 'rate_limiting_limit']) {
    if (!(unset(gateway[field]) || gateway[field] === 0)) warnings.push(`${field} is ${show(gateway[field])}: the gateway may answer 429 before this installation's own limits`);
  }
  if (hasContent(gateway.spend_limits) && gateway.spend_limits?.enabled !== false) warnings.push('spend limits are configured: the gateway may refuse requests (429)');
  if (hasContent(gateway.stripe)) warnings.push('Stripe usage events are configured');
  if (hasContent(gateway.log_classification)) warnings.push(`log_classification is ${show(gateway.log_classification)}`);
  const unknown = Object.keys(gateway).filter((field) => !KNOWN_GATEWAY_FIELDS.includes(field)).sort();
  if (unknown.length > 0) warnings.push(`fields this installer does not know: ${unknown.join(', ')} (review them in the dashboard)`);
  return { refusals, warnings };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Non-secret fingerprint of the policy-relevant settings, recorded in the receipt. */
export function settingsDigest(gateway) {
  const picked = Object.fromEntries(POLICY_FIELDS.map((field) => [field, gateway[field] ?? null]));
  return `sha256:${createHash('sha256').update(canonical(picked)).digest('hex').slice(0, 16)}`;
}

// ---------- probes ----------

/**
 * Two requests to the gateway's OpenAI chat path with the body `{}` and no
 * provider credential, so no provider can serve them:
 *  - without the Run token: must be 401 `AiGatewayError` with internalCode
 *    2009 (the gateway requires authentication);
 *  - with the Run token (when supplied): must be 400 `AiGatewayError` (the
 *    token is accepted and the gateway refuses to go on without a provider
 *    key: `byok_only`, `cf-aig-no-wholesale`).
 * Anything else, including any 2xx or a body that is not an `AiGatewayError`,
 * fails the probe. Neither request is retried. Only the status, `name` and
 * `internalCode` are read.
 */
export async function probeGateway({ accountId, gatewayId, runToken = null, fetchImpl = defaultFetch, timeoutMs = GATEWAY_API_TIMEOUT_MS }) {
  if (!GATEWAY_ID_PATTERN.test(gatewayId) || gatewayId === 'default') throw new InstallerError(`internal error: invalid gateway id ${gatewayId}`);
  const url = `${GATEWAY_ORIGIN}/v1/${accountId}/${gatewayId}/openai/chat/completions`;
  const send = async (token) => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', ...gatewayRequestHeaders(token) },
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await readBounded(response);
      const gatewayError = json?.name === 'AiGatewayError';
      return {
        status: response.status,
        gatewayError,
        internalCode: gatewayError && Number.isInteger(json.internalCode) ? json.internalCode : null,
      };
    } catch (error) {
      return { status: 0, gatewayError: false, internalCode: null, failure: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  };
  const describe = (result) => (result.status === 0
    ? result.failure
    : `HTTP ${result.status}${result.gatewayError ? `, AiGatewayError${result.internalCode === null ? '' : ` ${result.internalCode}`}` : ', not an AiGatewayError'}`);
  const checks = [];
  const anonymous = await send(null);
  checks.push({
    id: 'gateway.probe.unauthenticated',
    ok: anonymous.status === 401 && anonymous.gatewayError && anonymous.internalCode === 2009,
    detail: `${describe(anonymous)} (expected HTTP 401, AiGatewayError 2009)`,
  });
  if (runToken) {
    const authenticated = await send(runToken);
    checks.push({
      id: 'gateway.probe.runToken',
      ok: authenticated.status === 400 && authenticated.gatewayError,
      detail: `${describe(authenticated)} (expected HTTP 400, AiGatewayError: token accepted, no provider key)`,
    });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

// ---------- provisioning ----------

function ownedOrRefuse(gateway, record, id, accountId) {
  const verdict = gatewayOwnership(gateway, record);
  if (!verdict.owned) {
    throw refuse(`AI Gateway ${id} exists in account ${accountId} but this installation cannot show that it created it (${verdict.reason}); refusing to adopt it`, [
      'The installer never adopts unrelated gateways and never deletes one.',
      'If it is unrelated, choose another --install name. If it is this installation\'s (a create whose reply was lost, seen with a skewed clock), delete it deliberately and rerun.',
    ]);
  }
  return verdict;
}

/**
 * Read-only collision check for a fresh installation: an existing gateway with
 * this installation's id is refused before any remote write.
 */
export async function assertNoForeignGateway({ api, names, accountId, record = null }) {
  const id = gatewayIdFor(names);
  const gateway = await api.getGateway(id);
  if (gateway) ownedOrRefuse(gateway, record, id, accountId);
  return gateway;
}

/**
 * The gateway this installation observed is gone: deleted in the dashboard
 * (the installer never deletes one) while the installation was on direct.
 * Its observation and create attempts vouched for that gateway only, so they
 * are moved to `superseded`; the gateway created next is observed afresh, and
 * a lost reply is settled by this run's attempt alone.
 */
function supersedeGateway(record, out, id) {
  out.line(`Note: AI Gateway ${id}, recorded as created ${record.createdAt ?? 'at an unknown time'}, no longer exists; a new one is created and recorded in its place.`);
  record.superseded = [
    ...(record.superseded ?? []),
    { createdAt: record.createdAt, observedAt: record.observedAt, attempts: record.attempts, missingAt: now() },
  ];
  record.attempts = [];
  record.createdAt = null;
  record.observedAt = null;
  record.settingsDigest = null;
  record.settingsCheckedAt = null;
}

/**
 * Both probes of the installation's gateway (probeGateway), printed. The
 * caller refuses when `ok` is false; `probedAt` is recorded here only when a
 * Run token was probed and accepted.
 */
export async function runGatewayProbe({ receipt, runToken, out, fetchImpl = defaultFetch }) {
  const id = gatewayIdFor(receipt.names);
  out.step(`Probing AI Gateway ${id} without a provider call${runToken ? ' (also with the supplied Run token)' : ''}`);
  const probe = await probeGateway({ accountId: receipt.accountId, gatewayId: id, runToken, fetchImpl });
  for (const check of probe.checks) out.line(`  ${check.ok ? '✓' : '✗'} ${check.id.padEnd(30)} ${check.detail}`);
  if (probe.ok && runToken) receipt.aiGateway.probedAt = now();
  return probe;
}

/**
 * The `ai-gateway` phase, also run by update --change-ai-transport:
 *  1. read the gateway; adopt it only on evidence, otherwise record an
 *     attempt, create it with the D7 settings and read it back (a recorded
 *     gateway that no longer exists is superseded first);
 *  2. refuse (exit 2) when its settings break the policy; never PUT;
 *  3. record the settings digest;
 *  4. probe it; the Run token too when its value is in memory.
 * `save()` persists the receipt; each step is recorded before the next remote call.
 */
export async function ensureGateway({ receipt, api, runToken, save, out, fetchImpl = defaultFetch }) {
  const id = gatewayIdFor(receipt.names);
  receipt.aiGateway ??= newGatewayRecord(receipt);
  const record = receipt.aiGateway;
  let gateway = await api.getGateway(id);
  if (gateway) {
    ownedOrRefuse(gateway, record, id, receipt.accountId);
  } else {
    if (record.observedAt) supersedeGateway(record, out, id);
    out.step(`Creating AI Gateway ${id} (authentication on, logs off, caching off, provider keys required)`);
    const attempt = { at: now() };
    record.attempts.push(attempt);
    save();
    const created = await api.createGateway(gatewayCreateBody(id));
    if (created.nameTaken) {
      // This call created nothing: never let its attempt vouch for the gateway.
      record.attempts = record.attempts.filter((entry) => entry !== attempt);
      save();
    }
    gateway = await api.getGateway(id);
    if (!gateway) {
      if (created.nameTaken) throw refuse(`collision: AI Gateway ${id} is reported as taken but cannot be read in account ${receipt.accountId}`);
      throw created.error ?? new InstallerError(`AI Gateway ${id} not observed after creation; rerun to continue`);
    }
    // Created by this call when it succeeded (Cloudflare refuses a taken id);
    // otherwise a lost reply only inside a recorded attempt.
    if (!created.ok) ownedOrRefuse(gateway, record, id, receipt.accountId);
  }
  // First observation (created now, or adopted after a lost reply): its
  // creation time is what later runs compare against.
  if (!record.observedAt) {
    record.createdAt = gateway.created_at ?? null;
    record.observedAt = now();
  }
  save();

  const policy = gatewaySettingsPolicy(gateway, { id });
  for (const warning of policy.warnings) out.line(`Warning: AI Gateway ${id}: ${warning}.`);
  if (policy.refusals.length > 0) {
    throw refuse(`AI Gateway ${id} breaks the installation's gateway policy (RT-11); nothing further was changed:\n  - ${policy.refusals.join('\n  - ')}`, [
      'The installer never changes (PUT) or deletes a gateway. Correct these settings deliberately (dashboard: AI → AI Gateway → the gateway → Settings), then rerun.',
    ]);
  }
  record.settingsDigest = settingsDigest(gateway);
  record.settingsCheckedAt = now();
  save();

  const probe = await runGatewayProbe({ receipt, runToken, out, fetchImpl });
  if (!probe.ok) {
    throw refuse(`the AI Gateway ${id} probe did not answer as a gateway requiring authentication and provider keys; nothing further was changed`, [
      'A 401 with the Run token means the token is wrong or lacks AI Gateway Run on this account; any 2xx or a non-gateway error means the gateway or token is not what the policy expects.',
    ]);
  }
  if (runToken) save();
  return { gateway, probe, warnings: policy.warnings };
}

/**
 * verify / update: the gateway settings (policy) and the number of stored
 * logs (must be 0). Read-only; failures become failed checks, never writes.
 */
export async function gatewayChecks({ receipt, api }) {
  const id = receipt.aiGateway?.id ?? receipt.names.worker;
  const checks = [];
  let gateway;
  try {
    gateway = await api.getGateway(id);
  } catch (error) {
    checks.push({ id: 'gateway.settings', ok: false, detail: error.message });
    return checks;
  }
  if (!gateway) {
    checks.push({ id: 'gateway.settings', ok: false, detail: `AI Gateway ${id} not found in account ${receipt.accountId}` });
    return checks;
  }
  const verdict = gatewayOwnership(gateway, receipt.aiGateway);
  const policy = gatewaySettingsPolicy(gateway, { id });
  const problems = [...(verdict.owned ? [] : [`not this installation's gateway (${verdict.reason})`]), ...policy.refusals];
  const changed = receipt.aiGateway?.settingsDigest && settingsDigest(gateway) !== receipt.aiGateway.settingsDigest;
  checks.push({
    id: 'gateway.settings',
    ok: problems.length === 0,
    detail: problems.length > 0
      ? problems.join('; ')
      : `matches the policy${policy.warnings.length ? `; warnings: ${policy.warnings.join('; ')}` : ''}${changed ? '; settings changed since they were recorded' : ''}`,
  });
  try {
    const count = await api.logCount(id);
    checks.push({
      id: 'gateway.logs',
      ok: count === 0,
      detail: count === null ? 'the API reported no log count' : `${count} stored log${count === 1 ? '' : 's'} (expected 0)`,
    });
  } catch (error) {
    checks.push({ id: 'gateway.logs', ok: false, detail: error.message });
  }
  return checks;
}
