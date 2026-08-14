// POST /api/onboarding/save-credentials - Encrypt and store researcher credentials
// Only available in hosted mode

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getHostedResearcherIdentity, hasRecentResearcherSession } from '@/lib/researcherContext';
import {
  getResearcherByIdChecked,
  consumePlatformRateLimit,
  updateResearcherCredentialsAtomic,
} from '@/lib/platformDb';
import { decrypt, encrypt } from '@/lib/crypto';
import { isHostedMode } from '@/lib/mode';
import {
  normalizeCredential,
  validateAiCredential,
  validateRedisCredentials,
} from '@/lib/credentialValidation';
import { evictResearcherClients } from '@/lib/kvClient';
import { readBoundedJsonObject } from '@/lib/requestBody';

const hasOwn = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);

export async function POST(request: Request) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: 'Only available in hosted mode' }, { status: 404 });
  }

  const identity = await getHostedResearcherIdentity();
  const { authorized, researcherId, error } = identity;
  if (!authorized || !researcherId) {
    return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
  }
  if (!hasRecentResearcherSession(identity, 60 * 60)) {
    return NextResponse.json(
      { error: 'Sign out and sign in again before changing credentials' },
      { status: 403 }
    );
  }

  const rateLimit = await consumePlatformRateLimit('credential-save', researcherId, 12, 3_600);
  if (rateLimit.status === 'unavailable') {
    return NextResponse.json({ error: 'Credential service is temporarily unavailable' }, { status: 503 });
  }
  if (rateLimit.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many credential updates. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }
    );
  }

  try {
    const parsedBody = await readBoundedJsonObject(request, 20_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Request body is too large' : 'Invalid request body' },
        { status: parsedBody.status }
      );
    }
    const body = parsedBody.value;
    const hasRedisUrl = hasOwn(body, 'redisUrl');
    const hasRedisToken = hasOwn(body, 'redisToken');
    const hasGemini = hasOwn(body, 'geminiApiKey');
    const hasAnthropic = hasOwn(body, 'anthropicApiKey');

    if (hasRedisUrl !== hasRedisToken) {
      return NextResponse.json({ error: 'Redis URL and token must be updated together' }, { status: 400 });
    }
    if (!hasRedisUrl && !hasGemini && !hasAnthropic) {
      return NextResponse.json({ error: 'No credentials provided' }, { status: 400 });
    }

    const loaded = await getResearcherByIdChecked(researcherId);
    if (loaded.status === 'unavailable') {
      return NextResponse.json({ error: 'Account storage is temporarily unavailable' }, { status: 503 });
    }
    if (loaded.status === 'not-found') {
      return NextResponse.json({ error: 'Researcher account not found' }, { status: 404 });
    }
    const researcher = loaded.researcher;

    const redisUrl = hasRedisUrl ? normalizeCredential(body.redisUrl) : null;
    const redisToken = hasRedisToken ? normalizeCredential(body.redisToken) : null;
    if (hasRedisUrl && (!redisUrl || !redisToken)) {
      return NextResponse.json({ error: 'Redis URL and token are required and must be valid strings' }, { status: 400 });
    }

    const geminiApiKey = typeof body.geminiApiKey === 'string'
      ? normalizeCredential(body.geminiApiKey)
      : null;
    const anthropicApiKey = typeof body.anthropicApiKey === 'string'
      ? normalizeCredential(body.anthropicApiKey)
      : null;
    if (hasGemini && body.geminiApiKey !== null && !geminiApiKey) {
      return NextResponse.json({ error: 'Gemini API key is invalid' }, { status: 400 });
    }
    if (hasAnthropic && body.anthropicApiKey !== null && !anthropicApiKey) {
      return NextResponse.json({ error: 'Claude API key is invalid' }, { status: 400 });
    }
    if (hasGemini && body.geminiApiKey !== null && typeof body.geminiApiKey !== 'string') {
      return NextResponse.json({ error: 'Gemini API key must be a string or null' }, { status: 400 });
    }
    if (hasAnthropic && body.anthropicApiKey !== null && typeof body.anthropicApiKey !== 'string') {
      return NextResponse.json({ error: 'Claude API key must be a string or null' }, { status: 400 });
    }

    if (redisUrl && redisToken) {
      const validation = await validateRedisCredentials(redisUrl, redisToken);
      if (!validation.valid) {
        return NextResponse.json(
          { error: validation.reason === 'invalid' ? 'Redis credentials are invalid' : 'Could not verify Redis credentials' },
          { status: validation.reason === 'invalid' ? 400 : 503 }
        );
      }
    }

    for (const [provider, apiKey] of [
      ['gemini', geminiApiKey],
      ['claude', anthropicApiKey],
    ] as const) {
      if (!apiKey) continue;
      const validation = await validateAiCredential(provider, apiKey);
      if (!validation.valid) {
        return NextResponse.json(
          { error: validation.reason === 'invalid' ? `${provider === 'gemini' ? 'Gemini' : 'Claude'} API key is invalid` : `Could not verify the ${provider === 'gemini' ? 'Gemini' : 'Claude'} API key` },
          { status: validation.reason === 'invalid' ? 400 : 503 }
        );
      }
    }

    const updates: Parameters<typeof updateResearcherCredentialsAtomic>[2] = {};
    if (redisUrl && redisToken) {
      updates.encryptedRedisUrl = encrypt(redisUrl, { researcherId, purpose: 'redis-url' });
      updates.encryptedRedisToken = encrypt(redisToken, { researcherId, purpose: 'redis-token' });
      updates.redisConfiguredAt = Date.now();
    }
    if (hasGemini) {
      updates.encryptedGeminiApiKey = geminiApiKey
        ? encrypt(geminiApiKey, { researcherId, purpose: 'gemini-api-key' })
        : null;
    }
    if (hasAnthropic) {
      updates.encryptedAnthropicApiKey = anthropicApiKey
        ? encrypt(anthropicApiKey, { researcherId, purpose: 'anthropic-api-key' })
        : null;
    }

    const resultingHasRedis = hasRedisUrl
      ? true
      : !!(researcher.encryptedRedisUrl && researcher.encryptedRedisToken);
    const resultingHasAi = (hasGemini ? !!geminiApiKey : !!researcher.encryptedGeminiApiKey)
      || (hasAnthropic ? !!anthropicApiKey : !!researcher.encryptedAnthropicApiKey);
    if (!resultingHasRedis || !resultingHasAi) updates.onboardingComplete = false;

    const result = await updateResearcherCredentialsAtomic(
      researcherId,
      researcher.credentialRevision ?? 0,
      updates
    );
    if (result.status === 'conflict') {
      return NextResponse.json({ error: 'Credentials changed in another request. Refresh and try again.' }, { status: 409 });
    }
    if (result.status === 'not-found') {
      return NextResponse.json({ error: 'Researcher account not found' }, { status: 404 });
    }
    if (result.status !== 'updated') {
      return NextResponse.json({ error: 'Failed to save credentials' }, { status: 503 });
    }

    if (hasRedisUrl && researcher.encryptedRedisUrl) {
      try {
        evictResearcherClients(decrypt(researcher.encryptedRedisUrl, {
          researcherId,
          purpose: 'redis-url',
        }));
      } catch {
        // A corrupt/retired envelope cannot safely identify its cache entry.
        // Clear the bounded cache rather than retaining a superseded token.
        evictResearcherClients();
      }
    }

    return NextResponse.json({
      success: true,
      onboardingComplete: updates.onboardingComplete === false ? false : researcher.onboardingComplete,
      configured: {
        redis: resultingHasRedis,
        gemini: hasGemini ? !!geminiApiKey : !!researcher.encryptedGeminiApiKey,
        anthropic: hasAnthropic ? !!anthropicApiKey : !!researcher.encryptedAnthropicApiKey,
      },
    });
  } catch (error) {
    console.error('Save credentials error:', error);
    return NextResponse.json(
      { error: 'Failed to save credentials' },
      { status: 500 }
    );
  }
}
