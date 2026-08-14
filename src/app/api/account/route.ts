// DELETE /api/account - Delete the hosted platform account only.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { isHostedMode } from '@/lib/mode';
import { getHostedResearcherIdentity, hasRecentResearcherSession } from '@/lib/researcherContext';
import {
  consumePlatformRateLimit,
  deleteResearcherAccount,
  getResearcherByIdChecked,
} from '@/lib/platformDb';
import { decrypt } from '@/lib/crypto';
import { evictResearcherClients } from '@/lib/kvClient';
import { SESSION_COOKIE_NAME } from '@/lib/auth';
import { readBoundedJsonObject } from '@/lib/requestBody';

export async function DELETE(request: Request) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: 'Only available in hosted mode' }, { status: 404 });
  }

  const identity = await getHostedResearcherIdentity();
  if (!identity.authorized || !identity.researcherId) {
    return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
  }
  if (!hasRecentResearcherSession(identity, 15 * 60)) {
    return NextResponse.json(
      { error: 'Sign out and sign in again before deleting your account' },
      { status: 403 }
    );
  }
  const rateLimit = await consumePlatformRateLimit('account-delete', identity.researcherId, 10, 3_600);
  if (rateLimit.status === 'unavailable') {
    return NextResponse.json({ error: 'Account service is temporarily unavailable' }, { status: 503 });
  }
  if (rateLimit.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many deletion attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }
    );
  }

  const loaded = await getResearcherByIdChecked(identity.researcherId);
  if (loaded.status === 'unavailable') {
    return NextResponse.json({ error: 'Account storage is temporarily unavailable' }, { status: 503 });
  }
  if (loaded.status === 'not-found') {
    return NextResponse.json({ error: 'Researcher account not found' }, { status: 404 });
  }
  const researcher = loaded.researcher;

  const parsedBody = await readBoundedJsonObject(request, 1_000);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.status === 413 ? 'Request body is too large' : 'Invalid request body' },
      { status: parsedBody.status }
    );
  }
  const confirmation = parsedBody.value.confirmation;
  if (typeof confirmation !== 'string' || confirmation.trim().toLowerCase() !== researcher.email.toLowerCase()) {
    return NextResponse.json({ error: 'Enter your account email to confirm deletion' }, { status: 400 });
  }

  const result = await deleteResearcherAccount(researcher);
  if (result.status === 'too-many-records') {
    return NextResponse.json({ error: 'Account has too many platform mappings for automatic deletion. Contact the operator.' }, { status: 409 });
  }
  if (result.status !== 'deleted' && result.status !== 'not-found') {
    return NextResponse.json({ error: 'Account deletion is temporarily unavailable' }, { status: 503 });
  }

  if (researcher.encryptedRedisUrl) {
    try {
      evictResearcherClients(decrypt(researcher.encryptedRedisUrl, {
        researcherId: identity.researcherId,
        purpose: 'redis-url',
      }));
    } catch {
      evictResearcherClients();
    }
  }

  const response = NextResponse.json({
    success: true,
    externalDataDeleted: false,
    message: 'Platform account deleted. Data in your external Redis database was not changed.',
  });
  response.cookies.set(SESSION_COOKIE_NAME, '', { path: '/', expires: new Date(0) });
  return response;
}
