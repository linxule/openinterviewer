// POST /api/onboarding/complete - Mark onboarding as complete
// Only available in hosted mode

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getHostedResearcherIdentity } from '@/lib/researcherContext';
import {
  getResearcherByIdChecked,
  consumePlatformRateLimit,
  updateResearcherCredentialsAtomic,
} from '@/lib/platformDb';
import { isHostedMode } from '@/lib/mode';
import { decrypt } from '@/lib/crypto';
import { validateAiCredential, validateRedisCredentials } from '@/lib/credentialValidation';
import { cookies } from 'next/headers';
import {
  normalizeOAuthReturnPath,
  POST_ONBOARDING_RETURN_COOKIE_NAME,
} from '@/lib/hostedOAuth';

export async function POST() {
  if (!isHostedMode()) {
    return NextResponse.json({ error: 'Only available in hosted mode' }, { status: 404 });
  }

  const { authorized, researcherId, error } = await getHostedResearcherIdentity();
  if (!authorized || !researcherId) {
    return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
  }

  const rateLimit = await consumePlatformRateLimit('onboarding-complete', researcherId, 12, 3_600);
  if (rateLimit.status === 'unavailable') {
    return NextResponse.json({ error: 'Onboarding validation is temporarily unavailable' }, { status: 503 });
  }
  if (rateLimit.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many onboarding attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }
    );
  }

  try {
    const loaded = await getResearcherByIdChecked(researcherId);
    if (loaded.status === 'unavailable') {
      return NextResponse.json({ error: 'Account storage is temporarily unavailable' }, { status: 503 });
    }
    if (loaded.status === 'not-found') {
      return NextResponse.json({ error: 'Researcher account not found' }, { status: 404 });
    }
    const researcher = loaded.researcher;
    if (
      !researcher.encryptedRedisUrl
      || !researcher.encryptedRedisToken
      || (!researcher.encryptedGeminiApiKey && !researcher.encryptedAnthropicApiKey)
    ) {
      return NextResponse.json({ error: 'Storage and at least one AI provider must be configured' }, { status: 400 });
    }

    let redisUrl: string;
    let redisToken: string;
    let geminiApiKey: string | null = null;
    let anthropicApiKey: string | null = null;
    try {
      redisUrl = decrypt(researcher.encryptedRedisUrl, { researcherId, purpose: 'redis-url' });
      redisToken = decrypt(researcher.encryptedRedisToken, { researcherId, purpose: 'redis-token' });
      geminiApiKey = researcher.encryptedGeminiApiKey
        ? decrypt(researcher.encryptedGeminiApiKey, { researcherId, purpose: 'gemini-api-key' })
        : null;
      anthropicApiKey = researcher.encryptedAnthropicApiKey
        ? decrypt(researcher.encryptedAnthropicApiKey, { researcherId, purpose: 'anthropic-api-key' })
        : null;
    } catch {
      return NextResponse.json({ error: 'Stored credentials could not be decrypted. Rotate them in settings.' }, { status: 409 });
    }

    const redisValidation = await validateRedisCredentials(redisUrl, redisToken);
    if (!redisValidation.valid) {
      return NextResponse.json(
        { error: redisValidation.reason === 'invalid' ? 'Stored Redis credentials are invalid' : 'Could not verify stored Redis credentials' },
        { status: redisValidation.reason === 'invalid' ? 400 : 503 }
      );
    }

    const aiValidations = await Promise.all([
      geminiApiKey ? validateAiCredential('gemini', geminiApiKey) : null,
      anthropicApiKey ? validateAiCredential('claude', anthropicApiKey) : null,
    ]);
    const validAi = aiValidations.some(result => result?.valid === true);
    if (!validAi) {
      const unavailable = aiValidations.some(result => result?.valid === false && result.reason === 'unavailable');
      return NextResponse.json(
        { error: unavailable ? 'Could not verify an AI provider right now' : 'No stored AI credential is valid' },
        { status: unavailable ? 503 : 400 }
      );
    }

    const result = await updateResearcherCredentialsAtomic(
      researcherId,
      researcher.credentialRevision ?? 0,
      { onboardingComplete: true }
    );
    if (result.status === 'conflict') {
      return NextResponse.json({ error: 'Credentials changed during validation. Try again.' }, { status: 409 });
    }
    if (result.status !== 'updated') {
      return NextResponse.json({ error: 'Failed to complete onboarding' }, { status: 503 });
    }

    const cookieStore = await cookies();
    const redirectPath = normalizeOAuthReturnPath(
      cookieStore.get(POST_ONBOARDING_RETURN_COOKIE_NAME)?.value
    );
    cookieStore.delete(POST_ONBOARDING_RETURN_COOKIE_NAME);
    return NextResponse.json({ success: true, redirectPath });
  } catch (error) {
    console.error('Onboarding complete error:', error);
    return NextResponse.json(
      { error: 'Failed to complete onboarding' },
      { status: 500 }
    );
  }
}
