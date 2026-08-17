// POST /api/account/reconcile-deletion — resume a journaled hosted deletion.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { isHostedMode } from '@/lib/mode';
import { getHostedResearcherIdentity } from '@/lib/researcherContext';
import {
  consumePlatformRateLimit,
  hasAccountDeleteJournal,
  resumeAccountDeletion,
} from '@/lib/platformDb';
import { isResearcherId } from '@/lib/wire/types';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { schemaHoldResponse } from '@/lib/researcherAccess';

const OPERATOR_HEADER = 'ACCOUNT_DELETE_RECONCILE_TOKEN';

function pendingBody(researcherId: string) {
  return { deletionPending: true, researcherId };
}

function completeBody() {
  return {
    success: true,
    externalDataDeleted: false,
  };
}

export async function POST(request: Request) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: 'Only available in hosted mode' }, { status: 404 });
  }

  const operatorHeader = request.headers.get(OPERATOR_HEADER);
  let researcherId: string | null = null;

  if (operatorHeader !== null) {
    const expected = process.env.ACCOUNT_DELETE_RECONCILE_TOKEN;
    if (!expected) {
      return NextResponse.json(
        { error: 'Operator reconciliation is not configured', retryable: true },
        { status: 503 },
      );
    }
    if (operatorHeader !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const parsedBody = await readBoundedJsonObject(request, 1_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Request body is too large' : 'Invalid request body' },
        { status: parsedBody.status },
      );
    }
    const requested = parsedBody.value.researcherId;
    if (typeof requested !== 'string' || !isResearcherId(requested)) {
      return NextResponse.json({ error: 'researcherId is required' }, { status: 400 });
    }
    researcherId = requested;
  } else {
    const identity = await getHostedResearcherIdentity();
    if (!identity.authorized || !identity.researcherId) {
      return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
    }
    researcherId = identity.researcherId;
  }

  const rateLimit = await consumePlatformRateLimit('account-delete', researcherId, 10, 3_600);
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

  const journal = await hasAccountDeleteJournal(researcherId);
  if (journal === 'unavailable') {
    return NextResponse.json({ error: 'Account deletion is temporarily unavailable' }, { status: 503 });
  }
  if (journal === 'no') {
    return NextResponse.json(completeBody());
  }

  const resumed = await resumeAccountDeletion(researcherId);
  if (resumed.status === 'complete') {
    return NextResponse.json(completeBody());
  }
  if (resumed.status === 'pending') {
    return NextResponse.json(pendingBody(researcherId), { status: 202 });
  }
  return NextResponse.json(
    {
      error: 'Account deletion is temporarily unavailable',
      retryable: true,
      reason: resumed.status === 'ambiguous' ? 'ambiguous' : 'unavailable',
    },
    { status: 503 },
  );
}
