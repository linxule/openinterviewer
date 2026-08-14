import { isValidUpstashUrl } from './kvClient';

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CREDENTIAL_LENGTH = 4_096;

export type CredentialValidationResult =
  | { valid: true }
  | { valid: false; reason: 'invalid' | 'unavailable' };

export function normalizeCredential(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_CREDENTIAL_LENGTH) return null;
  return normalized;
}

export async function validateRedisCredentials(
  redisUrl: string,
  redisToken: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CredentialValidationResult> {
  if (!isValidUpstashUrl(redisUrl) || !normalizeCredential(redisToken)) {
    return { valid: false, reason: 'invalid' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const endpoint = new URL(redisUrl);
    endpoint.pathname = '/ping';
    endpoint.search = '';
    endpoint.hash = '';
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${redisToken}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      return {
        valid: false,
        reason: response.status === 400 || response.status === 401 || response.status === 403
          ? 'invalid'
          : 'unavailable',
      };
    }
    const body: unknown = await response.json();
    const result = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).result
      : undefined;
    return result === 'PONG'
      ? { valid: true }
      : { valid: false, reason: 'invalid' };
  } catch {
    return { valid: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

function invalidStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

export async function validateAiCredential(
  provider: 'gemini' | 'claude',
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CredentialValidationResult> {
  if (!normalizeCredential(apiKey)) return { valid: false, reason: 'invalid' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = provider === 'gemini'
      ? await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
          method: 'GET',
          headers: { 'x-goog-api-key': apiKey },
          signal: controller.signal,
          cache: 'no-store',
        })
      : await fetch('https://api.anthropic.com/v1/models?limit=1', {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          signal: controller.signal,
          cache: 'no-store',
        });

    if (response.ok) return { valid: true };
    return { valid: false, reason: invalidStatus(response.status) ? 'invalid' : 'unavailable' };
  } catch {
    return { valid: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}
