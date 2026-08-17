// DELETE /api/account/credentials - Clear selected hosted BYOS credentials.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { isHostedMode } from '@/lib/mode';
import { getHostedResearcherIdentity, hasRecentResearcherSession } from '@/lib/researcherContext';
import {
  consumePlatformRateLimit,
  getResearcherByIdChecked,
  updateResearcherCredentialsAtomic,
} from '@/lib/platformDb';
import { evictResearcherClients } from '@/lib/kvClient';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { schemaHoldResponse } from '@/lib/researcherAccess';

type CredentialTarget = 'gemini' | 'anthropic' | 'openai' | 'openrouter' | 'redis' | 'all';

function isTarget(value: unknown): value is CredentialTarget {
  return value === 'gemini'
    || value === 'anthropic'
    || value === 'openai'
    || value === 'openrouter'
    || value === 'redis'
    || value === 'all';
}

export async function DELETE(request: Request) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: 'Only available in hosted mode' }, { status: 404 });
  }

  const identity = await getHostedResearcherIdentity();
  if (!identity.authorized || !identity.researcherId) {
    return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
  }
  if (!hasRecentResearcherSession(identity, 60 * 60)) {
    return NextResponse.json(
      { error: 'Sign out and sign in again before changing credentials' },
      { status: 403 }
    );
  }
  const rateLimit = await consumePlatformRateLimit('credential-clear', identity.researcherId, 30, 3_600);
  if (rateLimit.status === 'hold') return schemaHoldResponse();
  if (rateLimit.status === 'unavailable') {
    return NextResponse.json({ error: 'Credential service is temporarily unavailable' }, { status: 503 });
  }
  if (rateLimit.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many credential changes. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }
    );
  }

  const parsedBody = await readBoundedJsonObject(request, 1_000);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.status === 413 ? 'Request body is too large' : 'Invalid request body' },
      { status: parsedBody.status }
    );
  }
  const target = parsedBody.value.target;
  if (!isTarget(target)) {
    return NextResponse.json({ error: 'Unknown credential target' }, { status: 400 });
  }

  const loaded = await getResearcherByIdChecked(identity.researcherId);
  if (loaded.status === 'unavailable') {
    return NextResponse.json({ error: 'Account storage is temporarily unavailable' }, { status: 503 });
  }
  if (loaded.status === 'not-found') {
    return NextResponse.json({ error: 'Researcher account not found' }, { status: 404 });
  }
  const researcher = loaded.researcher;
  const updates: Parameters<typeof updateResearcherCredentialsAtomic>[2] = {};
  if (target === 'gemini' || target === 'all') updates.encryptedGeminiApiKey = null;
  if (target === 'anthropic' || target === 'all') updates.encryptedAnthropicApiKey = null;
  if (target === 'openai' || target === 'all') updates.encryptedOpenAiApiKey = null;
  if (target === 'openrouter' || target === 'all') updates.encryptedOpenRouterApiKey = null;
  if (target === 'redis' || target === 'all') {
    updates.encryptedRedisUrl = null;
    updates.encryptedRedisToken = null;
    updates.redisConfiguredAt = null;
  }

  const hasRedisAfter = target !== 'redis' && target !== 'all'
    && !!researcher.encryptedRedisUrl
    && !!researcher.encryptedRedisToken;
  const hasGeminiAfter = target !== 'gemini' && target !== 'all'
    && !!researcher.encryptedGeminiApiKey;
  const hasAnthropicAfter = target !== 'anthropic' && target !== 'all'
    && !!researcher.encryptedAnthropicApiKey;
  const hasOpenAiAfter = target !== 'openai' && target !== 'all'
    && !!researcher.encryptedOpenAiApiKey;
  const hasOpenRouterAfter = target !== 'openrouter' && target !== 'all'
    && !!researcher.encryptedOpenRouterApiKey;
  if (!hasRedisAfter || (!hasGeminiAfter && !hasAnthropicAfter && !hasOpenAiAfter && !hasOpenRouterAfter)) {
    updates.onboardingComplete = false;
  }

  const result = await updateResearcherCredentialsAtomic(
    identity.researcherId,
    researcher.credentialRevision ?? 0,
    updates
  );
  if (result.status === 'conflict') {
    return NextResponse.json({ error: 'Credentials changed in another request. Refresh and try again.' }, { status: 409 });
  }
  if (result.status === 'refused') {
    return NextResponse.json(
      { error: 'Cannot clear Redis while studies or live operations exist.' },
      { status: 409 },
    );
  }
  if (result.status === 'ambiguous') {
    return NextResponse.json(
      { error: 'Credential update may have committed. Refresh and retry.', retryable: true, reason: 'ambiguous' },
      { status: 503 },
    );
  }
  if (result.status !== 'updated') {
    return NextResponse.json({ error: 'Failed to clear credentials' }, { status: 503 });
  }

  evictResearcherClients(result.evict);

  return NextResponse.json({
    success: true,
    onboardingComplete: updates.onboardingComplete === false ? false : researcher.onboardingComplete,
    configured: {
      redis: hasRedisAfter,
      gemini: hasGeminiAfter,
      anthropic: hasAnthropicAfter,
      openai: hasOpenAiAfter,
      openrouter: hasOpenRouterAfter,
    },
  });
}
