// Installer domain model: names, validation and fixed installation facts
// (SETUP-01, SETUP-02, SETUP-05). Pure functions; no I/O.

export class InstallerError extends Error {
  /**
   * @param {string} message operator-facing, never contains secret values
   * @param {{ exitCode?: number, hints?: string[] }} [options]
   */
  constructor(message, { exitCode = 1, hints = [] } = {}) {
    super(message);
    this.name = 'InstallerError';
    this.exitCode = exitCode;
    this.hints = hints;
  }
}

/** Refusal: the requested action would be unsafe or ambiguous. */
export const REFUSED = 2;
/** verify: the workspace is reachable but held in a maintenance state. */
export const HELD = 3;

export const ENVIRONMENTS = ['production', 'staging'];

export const PROVIDER_KEYS = {
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** CLI value → WORKSPACE_JURISDICTION var value. */
export const JURISDICTIONS = { eu: 'eu', fedramp: 'fedramp', none: '' };
export const RECOMMENDED_JURISDICTION = 'eu';

export const GENERATED_SECRETS = ['SESSION_SECRET', 'PARTICIPANT_TOKEN_SECRET', 'RATE_LIMIT_SALT', 'OPERATOR_TOKEN'];
export const EPOCH_SECRET = 'ANALYSIS_RECOVERY_EPOCH';
export const PASSWORD_SECRET = 'ADMIN_PASSWORD';
export const MIN_PASSWORD_LENGTH = 16;

/**
 * On Cloudflare, POST /api/auth refuses a body over this many bytes before
 * it compares the password (MAX_CLOUDFLARE_LOGIN_BODY_BYTES in
 * src/lib/loginBody.ts; tests/unit/adminPasswordLimit.test.ts keeps the two
 * equal). The Login page and the operator CLI both send
 * JSON.stringify({ password }), so a longer password could never sign in.
 */
export const MAX_LOGIN_BODY_BYTES = 1024;

/** UTF-8 size of the sign-in body the clients send for this password. */
export function loginBodyBytes(password) {
  return Buffer.byteLength(JSON.stringify({ password }), 'utf8');
}

/** Same template-value pattern as scripts/check-setup.mjs and src/lib/hostedConfig.ts. */
export const SECRET_PLACEHOLDERS = /^(?:change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|todo|secret$)/i;

export const BOOTSTRAP_STATES = ['open', 'recovery'];

export const PHASES = [
  'preflight',
  'identity',
  'resources',
  // Cloudflare AI Gateway transport only (SETUP-08); a direct installation
  // never records it (state.phaseDone treats it as done).
  'ai-gateway',
  'config',
  'deploy-initial',
  'secrets',
  'origin',
  'workspace-init',
  'bootstrap-clear',
  'verify',
];

/**
 * 2 adds `providerKeys`, `aiTransport`, `secretEvents` and the generalized
 * `pendingChange`; a format-1 receipt is migrated in memory on read
 * (state.readReceipt) and written back as 2; the first write keeps the
 * original bytes as receipt.format1.json for a rollback to a release from
 * before format 2 (state.writeReceipt).
 */
export const RECEIPT_FORMAT_VERSION = 2;
export const SUPPORTED_RECEIPT_FORMATS = [1, 2];

/** AI_TRANSPORT values the installer writes (RT-11). The Vercel `gateway` value is Node-only. */
export const AI_TRANSPORTS = ['direct', 'cloudflare-gateway'];
export const GATEWAY_TRANSPORT = 'cloudflare-gateway';
/** The AI Gateway Run token: a Worker secret, supplied on protected input (SETUP-08). */
export const GATEWAY_TOKEN_SECRET = 'CF_AI_GATEWAY_TOKEN';
/**
 * The Cloudflare API token that creates and reads the installation's gateway
 * (AI Gateway Read + Edit). Read from the installer's own environment only:
 * never bound, forwarded to a child process, written or logged.
 */
export const GATEWAY_ADMIN_TOKEN_ENV = 'CF_AI_GATEWAY_ADMIN_TOKEN';
/** Same rule as src/lib/providers/endpoint.ts (isWellFormedGatewayToken). */
export const MIN_GATEWAY_TOKEN_LENGTH = 32;

const INSTALL_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const CLOUDFLARE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
/** CF_AI_GATEWAY_ACCOUNT_ID / CF_AI_GATEWAY_ID rules of src/lib/providers/endpoint.ts. */
export const ACCOUNT_ID_PATTERN = ACCOUNT_ID;
export const GATEWAY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** The gateway an installation owns: named after its Worker, never `default` (D13). */
export function gatewayIdFor(names) {
  const id = names.worker;
  if (!GATEWAY_ID_PATTERN.test(id) || id === 'default') {
    throw new InstallerError(`derived AI Gateway id "${id}" is not a valid gateway id`, { exitCode: REFUSED });
  }
  return id;
}

export function validateInstallName(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InstallerError('--install <name> is required', { exitCode: REFUSED });
  }
  if (value.length > 24 || !INSTALL_NAME.test(value)) {
    throw new InstallerError(
      `invalid --install "${value}": use 1-24 lowercase letters, digits and dashes, starting and ending with a letter or digit`,
      { exitCode: REFUSED },
    );
  }
  // 'oi-<x>-staging' must never be both a production and a staging Worker name.
  if (value.endsWith('-staging')) {
    throw new InstallerError(`invalid --install "${value}": the "-staging" suffix is reserved for --env staging`, {
      exitCode: REFUSED,
    });
  }
  return value;
}

export function validateEnvironment(value) {
  if (!ENVIRONMENTS.includes(value)) {
    throw new InstallerError('--env must be production or staging', { exitCode: REFUSED });
  }
  return value;
}

export function validateProvider(value) {
  if (!Object.hasOwn(PROVIDER_KEYS, value)) {
    throw new InstallerError(`--provider must be one of ${Object.keys(PROVIDER_KEYS).join(', ')}`, { exitCode: REFUSED });
  }
  return value;
}

/**
 * `--provider-keys`/`--add-provider-key` value: comma-separated provider
 * names, or `all`. Returns them in PROVIDER_KEYS order, without duplicates.
 */
export function parseProviderList(value, option) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InstallerError(`${option} needs one or more of ${Object.keys(PROVIDER_KEYS).join(', ')} (comma-separated), or all`, { exitCode: REFUSED });
  }
  if (value.trim() === 'all') return Object.keys(PROVIDER_KEYS);
  const requested = value.split(',').map((entry) => entry.trim());
  for (const entry of requested) {
    if (!Object.hasOwn(PROVIDER_KEYS, entry)) {
      throw new InstallerError(`${option}: unknown provider "${entry}"; use ${Object.keys(PROVIDER_KEYS).join(', ')} or all`, { exitCode: REFUSED });
    }
  }
  return Object.keys(PROVIDER_KEYS).filter((provider) => requested.includes(provider));
}

/** The keys an installation binds: always including its default provider. */
export function validateProviderKeys(providerKeys, defaultProvider) {
  if (!providerKeys.includes(defaultProvider)) {
    throw new InstallerError(`--provider-keys must include the default provider ${defaultProvider} (--provider)`, { exitCode: REFUSED });
  }
  return providerKeys;
}

export function validateAiTransport(value, option = '--ai-transport') {
  if (!AI_TRANSPORTS.includes(value)) {
    throw new InstallerError(`${option} must be ${AI_TRANSPORTS.join(' or ')}`, {
      exitCode: REFUSED,
      hints: ['The Vercel AI Gateway (`gateway`) is Node-only; on Cloudflare use cloudflare-gateway (RT-11).'],
    });
  }
  return value;
}

export function validateJurisdiction(value) {
  if (!Object.hasOwn(JURISDICTIONS, value)) {
    throw new InstallerError('--jurisdiction must be eu, fedramp or none', { exitCode: REFUSED });
  }
  return value;
}

export function validateAccountId(value) {
  if (!ACCOUNT_ID.test(value)) throw new InstallerError('--account-id must be a 32-character hexadecimal account ID', { exitCode: REFUSED });
  return value;
}

export function validateCloudflareName(name) {
  if (name.length > 63 || !CLOUDFLARE_NAME.test(name)) {
    throw new InstallerError(`derived resource name "${name}" violates Cloudflare naming rules`, { exitCode: REFUSED });
  }
  return name;
}

/**
 * Resource names are derived once (first apply) and read from the receipt
 * afterwards. Staging always gets a separate Worker, Queue and DLQ.
 */
export function deriveNames(install, environment) {
  const worker = `oi-${install}${environment === 'staging' ? '-staging' : ''}`;
  const names = { worker, queue: `${worker}-analysis`, deadLetterQueue: `${worker}-analysis-dlq` };
  for (const name of Object.values(names)) validateCloudflareName(name);
  return names;
}

/**
 * Every secret an installation binds, for its recorded provider keys and
 * transport. A Run token left bound after a switch back to direct is allowed
 * but not required (it is never sent there).
 */
export function requiredSecretNames(providerKeys, aiTransport = 'direct') {
  return [
    PASSWORD_SECRET,
    ...GENERATED_SECRETS,
    EPOCH_SECRET,
    ...providerKeys.map((provider) => PROVIDER_KEYS[provider]),
    ...(aiTransport === GATEWAY_TRANSPORT ? [GATEWAY_TOKEN_SECRET] : []),
  ];
}

function isIpLiteral(hostname) {
  if (hostname.startsWith('[')) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * RT-06 origin rules: HTTPS, no credentials/path/query/fragment, not a
 * local host. Returns the canonical origin string.
 */
export function validateOrigin(raw) {
  const fail = (why) => new InstallerError(`invalid --origin: ${why}`, { exitCode: REFUSED });
  if (typeof raw !== 'string' || raw.trim() !== raw || raw.length === 0) throw fail('empty or surrounded by whitespace');
  if (!/^https:\/\/[^/?#\s]+\/?$/i.test(raw)) throw fail('use https://<host> with no path, query or fragment');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail('not a URL');
  }
  if (url.protocol !== 'https:') throw fail('must use https');
  if (url.username || url.password) throw fail('must not contain credentials');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw fail('must not be a local host');
  if (isIpLiteral(host)) throw fail('must be a DNS host name, not an IP address');
  if (!host.includes('.')) throw fail('must be a fully qualified host name');
  return url.origin;
}

export function isWorkersDevOrigin(origin) {
  return new URL(origin).hostname.endsWith('.workers.dev');
}

/** `<worker>.<account subdomain>[.fed].workers.dev` for this exact Worker. */
export function isOwnWorkersDevHost(hostname, worker) {
  const escaped = worker.replace(/[-]/g, '\\-');
  return new RegExp(`^${escaped}\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.fed)?\\.workers\\.dev$`).test(hostname);
}

/**
 * Extract this Worker's workers.dev URL from deploy output. Only the indented
 * target lines of wrangler's `Deployed <worker> triggers` block count: the
 * bindings table printed earlier echoes plain-text var values (APP_BASE_URL
 * among them) and must not be mistaken for the deployed URL. Returns null
 * when absent; throws when the block names several different URLs for it.
 */
export function workersDevUrlFromOutput(output, worker) {
  const found = new Set();
  const lines = output.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^Deployed (\S+) triggers\b/.exec(lines[index].trim());
    if (!header || header[1] !== worker) continue;
    for (let next = index + 1; next < lines.length && /^\s+\S/.test(lines[next]); next += 1) {
      const target = /^https:\/\/([a-z0-9.-]+\.workers\.dev)$/i.exec(lines[next].trim());
      if (target && isOwnWorkersDevHost(target[1].toLowerCase(), worker)) found.add(`https://${target[1].toLowerCase()}`);
    }
  }
  if (found.size > 1) {
    throw new InstallerError(`deploy output names more than one workers.dev URL for ${worker}; set --origin explicitly`, {
      exitCode: REFUSED,
    });
  }
  return found.size === 1 ? [...found][0] : null;
}

export function installationKey(install, environment) {
  return `${install}-${environment}`;
}
