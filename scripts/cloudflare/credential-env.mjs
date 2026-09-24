// VERIFY-01: the one rule for credential-like environment variable names.
// The Cloudflare test launchers (tests/cloudflare-artifact/harness.ts,
// tests/e2e-cloudflare/server.mjs, tests/cloudflare-restart/runner.mjs)
// remove such variables from their own environment before wrangler is
// loaded, and check:cloudflare (check.mjs) removes them from every lane's
// environment. The Worker under test only ever receives the synthetic
// bindings its launcher passes explicitly. Only names are reported, never
// values. Node built-ins only.

export const CREDENTIAL_NAME = /(API_KEY|API_TOKEN|ACCOUNT_ID|_TOKEN$|SECRET|PASSWORD|KV_REST|UPSTASH|OIDC)/i;

/**
 * Sorted names (never values) of credential-like variables in `environment`.
 * @param {Record<string, string | undefined>} [environment]
 * @returns {string[]}
 */
export function credentialNames(environment = process.env) {
  return Object.keys(environment).filter((name) => CREDENTIAL_NAME.test(name)).sort();
}

/**
 * Deletes every credential-like variable from `environment` in place and
 * returns the names it removed.
 * @param {Record<string, string | undefined>} [environment]
 * @returns {string[]}
 */
export function scrubCredentials(environment = process.env) {
  const removed = credentialNames(environment);
  for (const name of removed) delete environment[name];
  return removed;
}

/**
 * A copy of `environment` without credential-like variables, and the names removed.
 * @param {Record<string, string | undefined>} [environment]
 * @returns {{ env: Record<string, string | undefined>, removed: string[] }}
 */
export function withoutCredentials(environment = process.env) {
  const env = { ...environment };
  return { env, removed: scrubCredentials(env) };
}

/**
 * The single notice a launcher prints after scrubbing: names only.
 * @param {string} who
 * @param {string[]} removed
 */
export function scrubNotice(who, removed) {
  return `${who}: removed credential-like environment variables (names only): ${removed.join(', ')}`;
}
