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
import { encrypt } from '@/lib/crypto';
import { isHostedMode } from '@/lib/mode';
import {
  normalizeCredential,
  validateAiCredential,
  validateRedisCredentials,
} from '@/lib/credentialValidation';
import { evictResearcherClients, storageIdFromRedisUrl } from '@/lib/kvClient';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { schemaHoldResponse } from '@/lib/researcherAccess';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

const hasOwn = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const providerLabel = {
  gemini: 'Gemini',
  claude: 'Claude',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
} as const;

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
  if (rateLimit.status === 'hold') return schemaHoldResponse();
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
    // Six independently bounded credentials can be rotated in one request.
    const parsedBody = await readBoundedJsonObject(request, 30_000);
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
    const hasOpenAi = hasOwn(body, 'openAiApiKey');
    const hasOpenRouter = hasOwn(body, 'openRouterApiKey');

    if (hasRedisUrl !== hasRedisToken) {
      return NextResponse.json({ error: 'Redis URL and token must be updated together' }, { status: 400 });
    }
    if (!hasRedisUrl && !hasGemini && !hasAnthropic && !hasOpenAi && !hasOpenRouter) {
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
    const openAiApiKey = typeof body.openAiApiKey === 'string'
      ? normalizeCredential(body.openAiApiKey)
      : null;
    const openRouterApiKey = typeof body.openRouterApiKey === 'string'
      ? normalizeCredential(body.openRouterApiKey)
      : null;
    if (hasGemini && body.geminiApiKey !== null && !geminiApiKey) {
      return NextResponse.json({ error: 'Gemini API key is invalid' }, { status: 400 });
    }
    if (hasAnthropic && body.anthropicApiKey !== null && !anthropicApiKey) {
      return NextResponse.json({ error: 'Claude API key is invalid' }, { status: 400 });
    }
    if (hasOpenAi && body.openAiApiKey !== null && !openAiApiKey) {
      return NextResponse.json({ error: 'OpenAI API key is invalid' }, { status: 400 });
    }
    if (hasOpenRouter && body.openRouterApiKey !== null && !openRouterApiKey) {
      return NextResponse.json({ error: 'OpenRouter API key is invalid' }, { status: 400 });
    }
    if (hasGemini && body.geminiApiKey !== null && typeof body.geminiApiKey !== 'string') {
      return NextResponse.json({ error: 'Gemini API key must be a string or null' }, { status: 400 });
    }
    if (hasAnthropic && body.anthropicApiKey !== null && typeof body.anthropicApiKey !== 'string') {
      return NextResponse.json({ error: 'Claude API key must be a string or null' }, { status: 400 });
    }
    if (hasOpenAi && body.openAiApiKey !== null && typeof body.openAiApiKey !== 'string') {
      return NextResponse.json({ error: 'OpenAI API key must be a string or null' }, { status: 400 });
    }
    if (hasOpenRouter && body.openRouterApiKey !== null && typeof body.openRouterApiKey !== 'string') {
      return NextResponse.json({ error: 'OpenRouter API key must be a string or null' }, { status: 400 });
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

    const aiCredentials = [
      ['gemini', geminiApiKey],
      ['claude', anthropicApiKey],
      ['openai', openAiApiKey],
      ['openrouter', openRouterApiKey],
    ] as const;
    const aiValidations = await Promise.all(aiCredentials.map(async ([provider, apiKey]) => ({
      provider,
      validation: apiKey ? await validateAiCredential(provider, apiKey) : null,
    })));
    const failedAiValidation = aiValidations.find(result => result.validation?.valid === false);
    if (failedAiValidation?.validation?.valid === false) {
      const { provider, validation } = failedAiValidation;
      return NextResponse.json(
        {
          error: validation.reason === 'invalid'
            ? `${providerLabel[provider]} API key is invalid`
            : `Could not verify the ${providerLabel[provider]} API key`,
        },
        { status: validation.reason === 'invalid' ? 400 : 503 }
      );
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
    if (hasOpenAi) {
      updates.encryptedOpenAiApiKey = openAiApiKey
        ? encrypt(openAiApiKey, { researcherId, purpose: 'openai-api-key' })
        : null;
    }
    if (hasOpenRouter) {
      updates.encryptedOpenRouterApiKey = openRouterApiKey
        ? encrypt(openRouterApiKey, { researcherId, purpose: 'openrouter-api-key' })
        : null;
    }

    const resultingHasRedis = hasRedisUrl
      ? true
      : !!(researcher.encryptedRedisUrl && researcher.encryptedRedisToken);
    const resultingHasAi = (hasGemini ? !!geminiApiKey : !!researcher.encryptedGeminiApiKey)
      || (hasAnthropic ? !!anthropicApiKey : !!researcher.encryptedAnthropicApiKey)
      || (hasOpenAi ? !!openAiApiKey : !!researcher.encryptedOpenAiApiKey)
      || (hasOpenRouter ? !!openRouterApiKey : !!researcher.encryptedOpenRouterApiKey);
    if (!resultingHasRedis || !resultingHasAi) updates.onboardingComplete = false;

    let origin: { storageId: string } | undefined;
    if (redisUrl && redisToken) {
      const storageId = storageIdFromRedisUrl(redisUrl);
      if (!storageId) {
        return NextResponse.json({ error: 'Redis credentials are invalid' }, { status: 400 });
      }
      origin = { storageId };
    }

    const result = origin
      ? await updateResearcherCredentialsAtomic(
        researcherId,
        researcher.credentialRevision ?? 0,
        updates,
        origin,
      )
      : await updateResearcherCredentialsAtomic(
        researcherId,
        researcher.credentialRevision ?? 0,
        updates,
      );
    if (result.status === 'conflict') {
      return NextResponse.json({ error: 'Credentials changed in another request. Refresh and try again.' }, { status: 409 });
    }
    if (result.status === 'refused') {
      return NextResponse.json(
        { error: 'Cannot replace Redis while studies or live operations exist.' },
        { status: 409 },
      );
    }
    if (result.status === 'not-found') {
      return NextResponse.json({ error: 'Researcher account not found' }, { status: 404 });
    }
    if (result.status === 'ambiguous') {
      return NextResponse.json(
        { error: 'Credential update may have committed. Refresh and retry.', retryable: true, reason: 'ambiguous' },
        { status: 503 },
      );
    }
    if (result.status !== 'updated') {
      return NextResponse.json({ error: 'Failed to save credentials' }, { status: 503 });
    }

    evictResearcherClients(result.evict);

    return NextResponse.json({
      success: true,
      onboardingComplete: updates.onboardingComplete === false ? false : researcher.onboardingComplete,
      configured: {
        redis: resultingHasRedis,
        gemini: hasGemini ? !!geminiApiKey : !!researcher.encryptedGeminiApiKey,
        anthropic: hasAnthropic ? !!anthropicApiKey : !!researcher.encryptedAnthropicApiKey,
        openai: hasOpenAi ? !!openAiApiKey : !!researcher.encryptedOpenAiApiKey,
        openrouter: hasOpenRouter ? !!openRouterApiKey : !!researcher.encryptedOpenRouterApiKey,
      },
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/onboarding/save-credentials',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to save credentials' },
      { status: 500 }
    );
  }
}
