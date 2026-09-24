// Ownership evidence for remote resources (SETUP-01, VERIFY-04: "resuming
// must recover the known installation without adopting unrelated
// resources"). A receipt attempt marker alone never proves ownership: it is
// written before the remote call, so it survives calls that never landed.
// A resource is this installation's only when
//   - its identifier was recorded after this installation observed creating
//     it (queue id, or the Worker's observedAt after a completed deploy), or
//   - Cloudflare's own creation timestamps fall inside the window of one of
//     this installation's recorded attempts (a lost reply).
// Pure functions; no I/O.

/** Tolerated difference between this machine's clock and Cloudflare's. */
export const CLOCK_SKEW_MS = 5 * 60_000;
/** Upper bound of one wrangler call (tools.mjs execTool default). */
export const WRANGLER_CALL_MS = 120_000;
/** Upper bound of one deploy.mjs run (tools.mjs runDeploy). */
export const DEPLOY_CALL_MS = 15 * 60_000;
/** Upper bound of one Cloudflare API call (gateway.mjs GATEWAY_API_TIMEOUT_MS). */
export const GATEWAY_CALL_MS = 30_000;

const DEPLOY_MESSAGE = /^openinterviewer ([0-9a-f]{12})$/;

/** Record an attempt before a remote call that may create `name`. */
export function recordAttempt(receipt, name, kind, extra = {}) {
  const record = (receipt.resources[name] ??= { kind, attempts: [] });
  record.attempts ??= [];
  const attempt = { at: new Date().toISOString(), ...extra };
  record.attempts.push(attempt);
  return attempt;
}

/** Forget an attempt that provably had no remote effect. */
export function dropAttempt(receipt, name, attempt) {
  const record = receipt.resources[name];
  if (!record) return;
  record.attempts = (record.attempts ?? []).filter((entry) => entry !== attempt);
  if (record.attempts.length === 0 && !record.observedAt && !record.id) delete receipt.resources[name];
}

function withinAttempt(createdOn, attempts, callMs) {
  const created = Date.parse(createdOn ?? '');
  if (!Number.isFinite(created)) return false;
  return attempts.some((attempt) => {
    const at = Date.parse(attempt.at ?? '');
    return Number.isFinite(at) && created >= at - CLOCK_SKEW_MS && created <= at + callMs + CLOCK_SKEW_MS;
  });
}

/**
 * @param {{ id?: string, created_on?: string }} row from `wrangler queues list`
 * @param {object | undefined} record receipt.resources[name]
 * @returns {{ owned: boolean, reason: string }}
 */
export function queueOwnership(row, record) {
  if (!record) return { owned: false, reason: 'no receipt record: this installation never tried to create it' };
  if (record.id) {
    return row.id === record.id
      ? { owned: true, reason: 'queue id recorded at creation' }
      : { owned: false, reason: `queue id ${row.id} differs from the recorded ${record.id} (deleted and recreated?)` };
  }
  const attempts = record.attempts ?? [];
  if (attempts.length === 0) return { owned: false, reason: 'no recorded create attempt' };
  if (withinAttempt(row.created_on, attempts, WRANGLER_CALL_MS)) {
    return { owned: true, reason: `created ${row.created_on}, during a recorded create attempt` };
  }
  return {
    owned: false,
    reason: `created ${row.created_on || 'at an unknown time'}, outside every recorded create attempt (${attempts.map((entry) => entry.at).join(', ')})`,
  };
}

/**
 * @param {Array<{ created_on?: string, annotations?: Record<string, string> }>} deployments
 *   from `wrangler deployments list --name <worker> --json`
 * @param {object | undefined} record receipt.resources[worker]
 * @returns {{ owned: boolean, reason: string }}
 */
export function workerOwnership(deployments, record) {
  if (!record) return { owned: false, reason: 'no receipt record: this installation never tried to deploy it' };
  if (record.observedAt) return { owned: true, reason: 'observed after this installation deployed it' };
  const attempts = record.attempts ?? [];
  if (attempts.length === 0) return { owned: false, reason: 'no recorded deploy attempt' };
  if (!Array.isArray(deployments) || deployments.length === 0) {
    return { owned: false, reason: 'the Worker exists but lists no deployments' };
  }
  const commits = new Set(attempts.map((entry) => entry.commit?.slice(0, 12)).filter(Boolean));
  for (const deployment of deployments) {
    if (!withinAttempt(deployment?.created_on, attempts, DEPLOY_CALL_MS)) {
      return {
        owned: false,
        reason: `deployment of ${deployment?.created_on || 'unknown time'} is outside every recorded deploy attempt (${attempts.map((entry) => entry.at).join(', ')})`,
      };
    }
    // The deploy.mjs message is a version annotation; when Cloudflare also
    // reports it on the deployment, it must be one this installation sent.
    const message = deployment?.annotations?.['workers/message'];
    if (message !== undefined) {
      const match = DEPLOY_MESSAGE.exec(message);
      if (!match || (commits.size > 0 && !commits.has(match[1]))) {
        return { owned: false, reason: `deployment message "${String(message).slice(0, 80)}" was not sent by this installation` };
      }
    }
  }
  return { owned: true, reason: 'every deployment falls inside a recorded deploy attempt' };
}

/**
 * The installation's AI Gateway (D13). Adopted only on evidence: this
 * installation observed it before (same `created_at` as recorded), or its
 * `created_at` falls inside a recorded create attempt (a lost reply). The
 * `default` gateway is never this installation's.
 *
 * @param {{ id?: string, created_at?: string, is_default?: boolean }} gateway from the Cloudflare API
 * @param {object | undefined | null} record receipt.aiGateway
 * @returns {{ owned: boolean, reason: string }}
 */
export function gatewayOwnership(gateway, record) {
  if (gateway?.id === 'default' || gateway?.is_default === true) return { owned: false, reason: 'it is the account\'s default gateway' };
  if (!record) return { owned: false, reason: 'no receipt record: this installation never tried to create it' };
  if (record.observedAt) {
    return record.createdAt && gateway?.created_at === record.createdAt
      ? { owned: true, reason: 'observed after this installation created it' }
      : { owned: false, reason: `created ${gateway?.created_at || 'at an unknown time'}, not ${record.createdAt} as recorded (deleted and recreated?)` };
  }
  const attempts = record.attempts ?? [];
  if (attempts.length === 0) return { owned: false, reason: 'no recorded create attempt' };
  if (withinAttempt(gateway?.created_at, attempts, GATEWAY_CALL_MS)) {
    return { owned: true, reason: `created ${gateway.created_at}, during a recorded create attempt` };
  }
  return {
    owned: false,
    reason: `created ${gateway?.created_at || 'at an unknown time'}, outside every recorded create attempt (${attempts.map((entry) => entry.at).join(', ')})`,
  };
}
