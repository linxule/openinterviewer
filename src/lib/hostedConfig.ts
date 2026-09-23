// Server-only deployment configuration and readiness validation.
// Never import this module from client components. The public DTO exposes
// booleans and stable error identifiers only — never secret or URL values.

import { isLocalAppHost, parseAppBaseUrl } from './appBaseUrl';
import { isValidUpstashUrl } from './kvClient';
import { resolveDeploymentMode } from './mode';
import {
  isGatewayAuthConfigured,
  isGatewayProvider,
  resolveAITransport,
  type AITransport,
} from './aiTransport';
import { resolveCapabilities, type AnalysisExecution } from './runtime/capabilities';
import { isProductionStrict } from './runtime/target';
import { workerBinding } from './runtime/workerInvocation';
import { isValidRecoveryEpoch, isValidWorkspaceId } from './storage/analysisProtocol';
import type { StoreReadiness } from './storage/types';

export const MIN_HOSTED_SECRET_LENGTH = 32;

export type HostedConfigError =
  | 'missing_deployment_mode'
  | 'invalid_deployment_mode'
  | 'missing_app_base_url'
  | 'invalid_app_base_url'
  | 'insecure_app_base_url'
  | 'missing_platform_key_prefix'
  | 'invalid_platform_key_prefix'
  | 'missing_platform_redis_url'
  | 'invalid_platform_redis_url'
  | 'missing_platform_redis_token'
  | 'missing_credential_key'
  | 'invalid_credential_key'
  | 'missing_session_secret'
  | 'weak_session_secret'
  | 'missing_participant_token_secret'
  | 'weak_participant_token_secret'
  | 'missing_rate_limit_salt'
  | 'weak_rate_limit_salt'
  | 'secrets_not_independent'
  | 'missing_oauth_provider'
  | 'incomplete_google_oauth'
  | 'incomplete_github_oauth'
  | 'missing_admin_password'
  | 'weak_admin_password'
  | 'missing_standalone_redis_url'
  | 'invalid_standalone_redis_url'
  | 'missing_standalone_redis_token'
  | 'missing_ai_provider_key'
  | 'invalid_ai_provider'
  | 'invalid_ai_transport'
  | 'gateway_not_supported_hosted'
  | 'missing_ai_gateway_auth'
  | 'invalid_gateway_ai_provider'
  | 'invalid_gateway_zdr'
  | 'invalid_platform_schema_lineage'
  | 'schema_hold'
  | 'invalid_deployment_target'
  | 'unsupported_cloudflare_mode'
  | 'unsupported_cloudflare_transport'
  | 'missing_workspace_store_binding'
  | 'missing_analysis_queue_binding'
  | 'invalid_workspace_id'
  | 'invalid_workspace_jurisdiction'
  | 'invalid_analysis_recovery_epoch'
  | 'invalid_workspace_bootstrap'
  | 'weak_operator_token'
  | 'placeholder_secret'
  | WorkspaceReadinessError;

/** Durable workspace readiness outcomes (Cloudflare target only). */
export type WorkspaceReadinessError =
  | 'workspace_unavailable'
  | 'workspace_uninitialized'
  | 'workspace_schema_unsupported'
  | 'workspace_identity_mismatch'
  | 'workspace_recovery_epoch_mismatch'
  | 'workspace_maintenance';

export type OAuthProviderId = 'google' | 'github';

// Runtime schema-lineage HOLD (Revision 12 §4): hosted APIs offline, writes
// 503 { retryable:false, reason:'schema-hold' }, readiness false. Readiness
// routes consult Redis lineage after env validation.
export const SCHEMA_HOLD_ERROR: HostedConfigError = 'schema_hold';
export const PLATFORM_SCHEMA_LINEAGE_SENTINEL = 'v2-clean';

export type PublicConfigView = {
  mode: 'standalone' | 'hosted' | null;
  aiTransport: AITransport | null;
  ready: boolean;
  oauth: Record<OAuthProviderId, boolean>;
  errors: HostedConfigError[];
  /**
   * Advertised analysis protocol, derived only from capability resolution.
   * It never authorizes a request and never overrides `ready: false`.
   */
  analysisExecution: AnalysisExecution | null;
};

/**
 * Presence of the Cloudflare bindings in the current Worker invocation.
 * Bindings never appear in process.env; callers pass what the invocation holds.
 * Presence does not prove that the Queue is being consumed.
 */
export type CloudflareBindingPresence = {
  workspaceStore: boolean;
  analysisQueue: boolean;
};

type ConfigEnv = NodeJS.ProcessEnv;

// Same template-value pattern as scripts/check-setup.mjs.
const SECRET_PLACEHOLDERS = /^(?:change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|todo|secret$)/i;

const PROVIDER_KEY_NAMES = {
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
} as const;

function hasMethod(value: unknown, name: string): boolean {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>)[name] === 'function';
}

/** Binding presence for the current Worker invocation; all false outside one. */
export function workerBindingPresence(): CloudflareBindingPresence {
  return {
    workspaceStore: hasMethod(workerBinding('WORKSPACE_STORE'), 'idFromName'),
    analysisQueue: hasMethod(workerBinding('ANALYSIS_QUEUE'), 'send'),
  };
}

function present(value: string | undefined): string {
  return value?.trim() ?? '';
}

function isCompletePair(id: string | undefined, secret: string | undefined): boolean {
  return present(id).length > 0 && present(secret).length > 0;
}

function isIncompletePair(id: string | undefined, secret: string | undefined): boolean {
  const hasId = present(id).length > 0;
  const hasSecret = present(secret).length > 0;
  return hasId !== hasSecret;
}

export function getConfiguredOAuthProviders(env: ConfigEnv = process.env): Record<OAuthProviderId, boolean> {
  return {
    google: isCompletePair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    github: isCompletePair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
  };
}

function pushSecretErrors(
  errors: HostedConfigError[],
  value: string,
  missing: HostedConfigError,
  weak: HostedConfigError
): string | null {
  if (!value) {
    errors.push(missing);
    return null;
  }
  if (value.length < MIN_HOSTED_SECRET_LENGTH) {
    errors.push(weak);
    return null;
  }
  return value;
}

function validateCredentialKey(
  value: string,
  activeKeyIdValue: string,
  errors: HostedConfigError[]
): void {
  const serialized = present(value || undefined);
  const activeKeyId = present(activeKeyIdValue || undefined);
  if (!serialized) {
    errors.push('missing_credential_key');
    return;
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('invalid_credential_key');
      return;
    }
    const entries = Object.entries(parsed);
    if (
      entries.length === 0
      || !activeKeyId
      || activeKeyId === 'legacy'
      || !Object.prototype.hasOwnProperty.call(parsed, activeKeyId)
      || entries.some(([keyId, keyValue]) => (
        !/^[A-Za-z0-9_-]{1,64}$/.test(keyId)
        || keyId === 'legacy'
        || typeof keyValue !== 'string'
        || !/^[A-Za-z0-9+/]{43}=$/.test(keyValue)
        || Buffer.from(keyValue, 'base64').length !== 32
      ))
    ) {
      errors.push('invalid_credential_key');
    }
  } catch {
    errors.push('invalid_credential_key');
  }
}

function validateAppBaseUrl(env: ConfigEnv, errors: HostedConfigError[]): void {
  const strict = isProductionStrict(env);
  const raw = present(env.APP_BASE_URL);
  if (!raw) {
    if (strict) {
      errors.push('missing_app_base_url');
    }
    return;
  }

  const url = parseAppBaseUrl(raw);
  if (!url) {
    errors.push('invalid_app_base_url');
    return;
  }

  if (strict && (url.protocol !== 'https:' || isLocalAppHost(url.hostname))) {
    errors.push('insecure_app_base_url');
  }
}

export function validateHostedConfig(env: ConfigEnv = process.env): HostedConfigError[] {
  const errors: HostedConfigError[] = [];

  try {
    if (resolveAITransport(env) !== 'direct') {
      errors.push('gateway_not_supported_hosted');
    }
  } catch {
    errors.push('invalid_ai_transport');
  }

  validateAppBaseUrl(env, errors);

  const keyPrefix = present(env.PLATFORM_KEY_PREFIX);
  if (!keyPrefix) {
    errors.push('missing_platform_key_prefix');
  } else if (!/^[a-z0-9_-]{1,64}$/.test(keyPrefix)) {
    errors.push('invalid_platform_key_prefix');
  }

  // The only value that bootstraps a new v2 lineage sentinel is exactly
  // 'v2-clean'; anything else set is a configuration error. Unset is legal
  // (existing sentinel, or HOLD until an operator sets it).
  const schemaLineage = present(env.PLATFORM_SCHEMA_LINEAGE);
  if (schemaLineage && schemaLineage !== PLATFORM_SCHEMA_LINEAGE_SENTINEL) {
    errors.push('invalid_platform_schema_lineage');
  }

  const redisUrl = present(env.PLATFORM_KV_REST_API_URL);
  const redisToken = present(env.PLATFORM_KV_REST_API_TOKEN);
  if (!redisUrl) {
    errors.push('missing_platform_redis_url');
  } else if (!isValidUpstashUrl(redisUrl)) {
    errors.push('invalid_platform_redis_url');
  }
  if (!redisToken) {
    errors.push('missing_platform_redis_token');
  }

  // New hosted deployments require a versioned keyring. The legacy single key
  // may remain configured only to decrypt pre-migration records.
  validateCredentialKey(
    present(env.CREDENTIAL_ENCRYPTION_KEYS),
    present(env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID),
    errors
  );

  const sessionSecret = pushSecretErrors(
    errors,
    present(env.SESSION_SECRET),
    'missing_session_secret',
    'weak_session_secret'
  );
  const participantSecret = pushSecretErrors(
    errors,
    present(env.PARTICIPANT_TOKEN_SECRET),
    'missing_participant_token_secret',
    'weak_participant_token_secret'
  );
  const rateLimitSalt = pushSecretErrors(
    errors,
    present(env.RATE_LIMIT_SALT),
    'missing_rate_limit_salt',
    'weak_rate_limit_salt'
  );

  const independent = [sessionSecret, participantSecret, rateLimitSalt].filter(
    (value): value is string => !!value
  );
  if (independent.length >= 2 && new Set(independent).size !== independent.length) {
    errors.push('secrets_not_independent');
  }

  const oauth = getConfiguredOAuthProviders(env);
  if (isIncompletePair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)) {
    errors.push('incomplete_google_oauth');
  }
  if (isIncompletePair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET)) {
    errors.push('incomplete_github_oauth');
  }
  if (!oauth.google && !oauth.github) {
    errors.push('missing_oauth_provider');
  }

  return errors;
}

export function validateStandaloneConfig(env: ConfigEnv = process.env): HostedConfigError[] {
  const errors: HostedConfigError[] = [];
  validateAppBaseUrl(env, errors);

  const adminPassword = present(env.ADMIN_PASSWORD);
  if (!adminPassword) errors.push('missing_admin_password');
  else if (adminPassword.length < 16) errors.push('weak_admin_password');

  const redisUrl = present(env.KV_REST_API_URL);
  if (!redisUrl) errors.push('missing_standalone_redis_url');
  else if (!isValidUpstashUrl(redisUrl)) errors.push('invalid_standalone_redis_url');
  if (!present(env.KV_REST_API_TOKEN)) errors.push('missing_standalone_redis_token');

  const selectedProvider = present(env.AI_PROVIDER);
  const effectiveProvider = selectedProvider || 'gemini';
  let transport: AITransport | null = null;
  try {
    transport = resolveAITransport(env);
  } catch {
    errors.push('invalid_ai_transport');
  }
  if (
    env.AI_GATEWAY_ZERO_DATA_RETENTION !== undefined
    && env.AI_GATEWAY_ZERO_DATA_RETENTION !== ''
    && env.AI_GATEWAY_ZERO_DATA_RETENTION !== 'true'
    && env.AI_GATEWAY_ZERO_DATA_RETENTION !== 'false'
  ) {
    errors.push('invalid_gateway_zdr');
  }

  if (transport === 'gateway') {
    if (!isGatewayAuthConfigured(env)) errors.push('missing_ai_gateway_auth');
    if (!isGatewayProvider(effectiveProvider)) {
      errors.push('invalid_gateway_ai_provider');
    }
  } else if (transport === 'direct') {
    const hasGemini = !!present(env.GEMINI_API_KEY);
    const hasAnthropic = !!present(env.ANTHROPIC_API_KEY);
    const hasOpenAi = !!present(env.OPENAI_API_KEY);
    const hasOpenRouter = !!present(env.OPENROUTER_API_KEY);
    if (!hasGemini && !hasAnthropic && !hasOpenAi && !hasOpenRouter) {
      errors.push('missing_ai_provider_key');
    }
    if (
      (
        selectedProvider
        && selectedProvider !== 'gemini'
        && selectedProvider !== 'claude'
        && selectedProvider !== 'openai'
        && selectedProvider !== 'openrouter'
      )
      || (effectiveProvider === 'gemini' && !hasGemini)
      || (effectiveProvider === 'claude' && !hasAnthropic)
      || (effectiveProvider === 'openai' && !hasOpenAi)
      || (effectiveProvider === 'openrouter' && !hasOpenRouter)
    ) {
      errors.push('invalid_ai_provider');
    }
  }

  const sessionSecret = pushSecretErrors(
    errors,
    present(env.SESSION_SECRET),
    'missing_session_secret',
    'weak_session_secret'
  );
  const participantSecret = pushSecretErrors(
    errors,
    present(env.PARTICIPANT_TOKEN_SECRET),
    'missing_participant_token_secret',
    'weak_participant_token_secret'
  );
  const rateLimitSalt = pushSecretErrors(
    errors,
    present(env.RATE_LIMIT_SALT),
    'missing_rate_limit_salt',
    'weak_rate_limit_salt'
  );
  const independent = [adminPassword || null, sessionSecret, participantSecret, rateLimitSalt]
    .filter((value): value is string => !!value);
  if (independent.length >= 2 && new Set(independent).size !== independent.length) {
    errors.push('secrets_not_independent');
  }
  return errors;
}

/**
 * Cloudflare standalone configuration. Never requires, validates or constructs
 * Redis. Capability errors (target, mode, transport) are resolved first by
 * getPublicConfig; this validates the remaining installation contract.
 */
export function validateCloudflareConfig(
  env: ConfigEnv,
  bindings: CloudflareBindingPresence,
): HostedConfigError[] {
  const errors: HostedConfigError[] = [];
  let placeholder = false;
  const isPlaceholder = (value: string): boolean => {
    if (!value || !SECRET_PLACEHOLDERS.test(value)) return false;
    placeholder = true;
    return true;
  };

  validateAppBaseUrl(env, errors);

  const rawAdminPassword = present(env.ADMIN_PASSWORD);
  const adminPassword = isPlaceholder(rawAdminPassword) ? '' : rawAdminPassword;
  if (!rawAdminPassword) errors.push('missing_admin_password');
  else if (adminPassword && adminPassword.length < 16) errors.push('weak_admin_password');

  const pushChecked = (
    name: 'SESSION_SECRET' | 'PARTICIPANT_TOKEN_SECRET' | 'RATE_LIMIT_SALT',
    missing: HostedConfigError,
    weak: HostedConfigError,
  ): string | null => {
    const raw = present(env[name]);
    if (isPlaceholder(raw)) return null;
    return pushSecretErrors(errors, raw, missing, weak);
  };
  const sessionSecret = pushChecked('SESSION_SECRET', 'missing_session_secret', 'weak_session_secret');
  const participantSecret = pushChecked(
    'PARTICIPANT_TOKEN_SECRET',
    'missing_participant_token_secret',
    'weak_participant_token_secret',
  );
  const rateLimitSalt = pushChecked('RATE_LIMIT_SALT', 'missing_rate_limit_salt', 'weak_rate_limit_salt');
  // Optional here: operator routes refuse without it, but its absence does not
  // make the deployment unready. A configured token is held to the secret rules.
  const rawOperatorToken = present(env.OPERATOR_TOKEN);
  let operatorToken: string | null = null;
  if (rawOperatorToken && !isPlaceholder(rawOperatorToken)) {
    if (rawOperatorToken.length < MIN_HOSTED_SECRET_LENGTH) errors.push('weak_operator_token');
    else operatorToken = rawOperatorToken;
  }
  const independent = [adminPassword || null, sessionSecret, participantSecret, rateLimitSalt, operatorToken]
    .filter((value): value is string => !!value);
  if (independent.length >= 2 && new Set(independent).size !== independent.length) {
    errors.push('secrets_not_independent');
  }

  const provider = present(env.AI_PROVIDER) || 'gemini';
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_KEY_NAMES, provider)) {
    errors.push('invalid_ai_provider');
  } else {
    const key = present(env[PROVIDER_KEY_NAMES[provider as keyof typeof PROVIDER_KEY_NAMES]]);
    if (!key) errors.push('missing_ai_provider_key');
    else isPlaceholder(key);
  }

  if (placeholder) errors.push('placeholder_secret');

  // Exact values: the Worker selects the Durable Object with these unmodified.
  if (!isValidWorkspaceId(env.WORKSPACE_ID)) errors.push('invalid_workspace_id');
  const jurisdiction = env.WORKSPACE_JURISDICTION ?? '';
  if (jurisdiction !== '' && jurisdiction !== 'eu' && jurisdiction !== 'fedramp') {
    errors.push('invalid_workspace_jurisdiction');
  }
  if (!isValidRecoveryEpoch(env.ANALYSIS_RECOVERY_EPOCH)) errors.push('invalid_analysis_recovery_epoch');
  const bootstrap = env.WORKSPACE_BOOTSTRAP ?? '';
  if (bootstrap !== '' && bootstrap !== 'open' && bootstrap !== 'recovery') {
    errors.push('invalid_workspace_bootstrap');
  }

  if (!bindings.workspaceStore) errors.push('missing_workspace_store_binding');
  if (!bindings.analysisQueue) errors.push('missing_analysis_queue_binding');
  return errors;
}

/** Maps a bounded Durable Object readiness result to a public error, or null when ready. */
export function workspaceReadinessError(readiness: StoreReadiness | null | undefined): WorkspaceReadinessError | null {
  if (!readiness || typeof readiness !== 'object') return 'workspace_unavailable';
  if (readiness.status === 'ready') {
    return readiness.maintenance === 'open' ? null : 'workspace_maintenance';
  }
  if (readiness.status === 'held') {
    switch (readiness.reason) {
      case 'maintenance':
        return 'workspace_maintenance';
      case 'workspace-uninitialized':
        return 'workspace_uninitialized';
      case 'schema-unsupported':
        return 'workspace_schema_unsupported';
      case 'workspace-identity-mismatch':
        return 'workspace_identity_mismatch';
      case 'recovery-epoch-mismatch':
        return 'workspace_recovery_epoch_mismatch';
      default:
        return 'workspace_unavailable';
    }
  }
  return 'workspace_unavailable';
}

function unresolvedView(error: HostedConfigError): PublicConfigView {
  return {
    mode: null,
    aiTransport: null,
    ready: false,
    oauth: { google: false, github: false },
    errors: [error],
    analysisExecution: null,
  };
}

export function getPublicConfig(
  env: ConfigEnv = process.env,
  bindings?: CloudflareBindingPresence,
): PublicConfigView {
  const capabilities = resolveCapabilities(env);
  if (!capabilities.ok && capabilities.error === 'invalid_deployment_target') {
    return unresolvedView('invalid_deployment_target');
  }

  if (capabilities.ok && capabilities.capabilities.target === 'cloudflare') {
    const errors = validateCloudflareConfig(env, bindings ?? workerBindingPresence());
    return {
      mode: 'standalone',
      aiTransport: 'direct',
      ready: errors.length === 0,
      oauth: { google: false, github: false },
      errors,
      analysisExecution: capabilities.capabilities.analysisExecution,
    };
  }
  if (!capabilities.ok && env.DEPLOYMENT_TARGET === 'cloudflare') {
    return unresolvedView(capabilities.error);
  }

  // Node target: existing standalone/hosted validation, unchanged.
  const analysisExecution = capabilities.ok ? capabilities.capabilities.analysisExecution : null;
  const resolved = resolveDeploymentMode(env);
  if (!resolved.ok) {
    return unresolvedView(resolved.error);
  }

  const oauth = getConfiguredOAuthProviders(env);
  let aiTransport: AITransport | null = null;
  try {
    aiTransport = resolveAITransport(env);
  } catch {
    aiTransport = null;
  }

  if (resolved.mode === 'standalone') {
    const errors = validateStandaloneConfig(env);
    return {
      mode: 'standalone',
      aiTransport,
      ready: errors.length === 0,
      oauth: { google: false, github: false },
      errors,
      analysisExecution,
    };
  }

  const errors = validateHostedConfig(env);
  return {
    mode: 'hosted',
    aiTransport,
    ready: errors.length === 0,
    oauth,
    errors,
    analysisExecution,
  };
}
