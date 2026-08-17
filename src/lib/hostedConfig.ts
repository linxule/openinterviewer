// Server-only hosted deployment configuration.
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
  | 'schema_hold';

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
};

type ConfigEnv = NodeJS.ProcessEnv;

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
  const raw = present(env.APP_BASE_URL);
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      errors.push('missing_app_base_url');
    }
    return;
  }

  const url = parseAppBaseUrl(raw);
  if (!url) {
    errors.push('invalid_app_base_url');
    return;
  }

  if (env.NODE_ENV === 'production' && (url.protocol !== 'https:' || isLocalAppHost(url.hostname))) {
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

export function getPublicConfig(env: ConfigEnv = process.env): PublicConfigView {
  const resolved = resolveDeploymentMode(env);
  if (!resolved.ok) {
    return {
      mode: null,
      aiTransport: null,
      ready: false,
      oauth: { google: false, github: false },
      errors: [resolved.error],
    };
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
    };
  }

  const errors = validateHostedConfig(env);
  return {
    mode: 'hosted',
    aiTransport,
    ready: errors.length === 0,
    oauth,
    errors,
  };
}
