// POST /api/studies/reconcile - Repair a bounded batch of hosted study sagas.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { isHostedMode } from '@/lib/mode';
import { consumePlatformRateLimit } from '@/lib/platformDb';
import { getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { reconcilePendingStudyOperations } from '@/lib/studyOperationReconciler';

export async function POST() {
  if (!isHostedMode()) {
    return NextResponse.json({ error: 'Only available in hosted mode' }, { status: 404 });
  }

  const access = await getRequestContext();
  const setupResponse = configurationRequiredResponse(access);
  if (setupResponse) return setupResponse;
  if (!access.authorized || !access.context || !access.researcherId) {
    return NextResponse.json({ error: access.error || 'Unauthorized' }, { status: 401 });
  }

  const rateLimit = await consumePlatformRateLimit(
    'study-reconcile',
    access.researcherId,
    30,
    3_600
  );
  if (rateLimit.status === 'unavailable') {
    return NextResponse.json({ error: 'Study reconciliation is temporarily unavailable' }, { status: 503 });
  }
  if (rateLimit.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many reconciliation attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }
    );
  }

  const result = await reconcilePendingStudyOperations(
    access.researcherId,
    access.context.kvClient,
    25
  );
  if (result.status === 'unavailable') {
    return NextResponse.json({ error: 'Study reconciliation is temporarily unavailable' }, { status: 503 });
  }

  return NextResponse.json(result);
}
