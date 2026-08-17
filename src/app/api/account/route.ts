// DELETE /api/account — journaled hosted platform account deletion.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { isHostedMode } from '@/lib/mode';
import { getHostedResearcherIdentity, hasRecentResearcherSession } from '@/lib/researcherContext';
import {
  beginAccountDeletion,
  consumePlatformRateLimit,
  getResearcherByIdChecked,
  hasAccountDeleteJournal,
  resumeAccountDeletion,
} from '@/lib/platformDb';
import { SESSION_COOKIE_NAME } from '@/lib/auth';
import { schemaHoldResponse } from '@/lib/researcherAccess';
import { readBoundedJsonObject } from '@/lib/requestBody';

function pendingBody(researcherId: string) {
  return { deletionPending: true, researcherId };
}

function completeBody() {
  return {
    success: true,
    externalDataDeleted: false,
    message: 'Platform account deleted. Data in your external Redis database was not changed.',
  };
}

function clearSession(response: NextResponse): NextResponse {
  response.cookies.set(SESSION_COOKIE_NAME, '', { path: '/', expires: new Date(0) });
  return response;
}

export async function DELETE(request: Request) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: 'Only available in hosted mode' }, { status: 404 });
  }

  const identity = await getHostedResearcherIdentity();
  if (!identity.authorized || !identity.researcherId) {
    return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
  }

  const rateLimit = await consumePlatformRateLimit('account-delete', identity.researcherId, 10, 3_600);
  if (rateLimit.status === 'hold') return schemaHoldResponse();
  if (rateLimit.status === 'unavailable') {
    return NextResponse.json({ error: 'Account service is temporarily unavailable' }, { status: 503 });
  }
  if (rateLimit.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many deletion attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } },
    );
  }

  const journal = await hasAccountDeleteJournal(identity.researcherId);
  if (journal === 'unavailable') {
    return NextResponse.json({ error: 'Account deletion is temporarily unavailable' }, { status: 503 });
  }

  if (journal === 'yes') {
    const resumed = await resumeAccountDeletion(identity.researcherId);
    if (resumed.status === 'complete') {
      return clearSession(NextResponse.json(completeBody()));
    }
    if (resumed.status === 'pending') {
      return NextResponse.json(pendingBody(identity.researcherId), { status: 202 });
    }
    return NextResponse.json(
      { error: 'Account deletion is temporarily unavailable', retryable: true },
      { status: 503 },
    );
  }

  if (!hasRecentResearcherSession(identity, 15 * 60)) {
    return NextResponse.json(
      { error: 'Sign out and sign in again before deleting your account' },
      { status: 403 },
    );
  }

  const loaded = await getResearcherByIdChecked(identity.researcherId);
  if (loaded.status === 'unavailable') {
    return NextResponse.json({ error: 'Account storage is temporarily unavailable' }, { status: 503 });
  }
  if (loaded.status === 'not-found') {
    return clearSession(NextResponse.json(completeBody()));
  }
  const researcher = loaded.researcher;

  const parsedBody = await readBoundedJsonObject(request, 1_000);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.status === 413 ? 'Request body is too large' : 'Invalid request body' },
      { status: parsedBody.status },
    );
  }
  const confirmation = parsedBody.value.confirmation;
  if (typeof confirmation !== 'string' || confirmation.trim().toLowerCase() !== researcher.email.toLowerCase()) {
    return NextResponse.json({ error: 'Enter your account email to confirm deletion' }, { status: 400 });
  }

  const begun = await beginAccountDeletion(researcher);
  if (begun.status === 'hold') return schemaHoldResponse();
  if (begun.status === 'too-many-records') {
    return NextResponse.json(
      { error: 'Account has too many platform mappings for automatic deletion. Contact the operator.' },
      { status: 409 },
    );
  }
  if (begun.status === 'not-found') {
    return clearSession(NextResponse.json(completeBody()));
  }
  if (begun.status !== 'started' && begun.status !== 'replay') {
    return NextResponse.json(
      {
        error: 'Account deletion is temporarily unavailable',
        retryable: true,
        reason: begun.status === 'ambiguous' ? 'ambiguous' : 'unavailable',
      },
      { status: 503 },
    );
  }

  const resumed = await resumeAccountDeletion(researcher.id);
  if (resumed.status === 'complete') {
    return clearSession(NextResponse.json(completeBody()));
  }
  if (resumed.status === 'pending') {
    return NextResponse.json(pendingBody(researcher.id), { status: 202 });
  }
  if (begun.status === 'started') {
    return NextResponse.json(pendingBody(researcher.id), { status: 202 });
  }
  return NextResponse.json(
    { error: 'Account deletion is temporarily unavailable', retryable: true },
    { status: 503 },
  );
}
