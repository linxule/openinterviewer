// POST /api/studies/reconcile - Repair a bounded batch of hosted study sagas.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { isHostedMode } from '@/lib/mode';
import { consumePlatformRateLimit } from '@/lib/platformDb';
import { getResearcherIdentity } from '@/lib/researcherContext';
import { getPlatformClient } from '@/lib/kvClient';
import { ensurePlatformSchemaLineage } from '@/lib/platformSchema';
import { reconcilePendingStudyOperations } from '@/lib/studyOperationReconciler';
import { schemaHoldResponse } from '@/lib/researcherAccess';

export async function POST() {
  if (!isHostedMode()) {
    return NextResponse.json({ error: 'Only available in hosted mode' }, { status: 404 });
  }

  const identity = await getResearcherIdentity();
  if (!identity.authorized || !identity.researcherId) {
    return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
  }

  try {
    const lineage = await ensurePlatformSchemaLineage(getPlatformClient());
    if (lineage === 'hold') {
      return NextResponse.json(
        { error: 'Platform schema is not ready', retryable: false, reason: 'schema-hold' },
        { status: 503 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'Study reconciliation is temporarily unavailable', retryable: true },
      { status: 503 },
    );
  }

  const rateLimit = await consumePlatformRateLimit(
    'study-reconcile',
    identity.researcherId,
    30,
    3_600,
  );
  if (rateLimit.status === 'hold') return schemaHoldResponse();
  if (rateLimit.status === 'unavailable') {
    return NextResponse.json({ error: 'Study reconciliation is temporarily unavailable' }, { status: 503 });
  }
  if (rateLimit.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many reconciliation attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } },
    );
  }

  const result = await reconcilePendingStudyOperations({ researcherId: identity.researcherId });
  if (result.status === 'unavailable') {
    return NextResponse.json({ error: 'Study reconciliation is temporarily unavailable' }, { status: 503 });
  }

  return NextResponse.json(result);
}
