// GET /api/studies/[id]/aggregate - Read the stored aggregate synthesis
// Protected: Requires authenticated session and study read authority

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getStudyAggregateChecked } from '@/lib/kv';
import { getAuthorizedResearcherStudyContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const gated = await getAuthorizedResearcherStudyContext(id, 'read');
    const denied = configurationRequiredResponse(gated);
    if (denied) return denied;
    if (!gated.authorized || !gated.context) {
      return NextResponse.json(
        {
          error: gated.error || 'Unauthorized',
          retryable: gated.retryable,
          ...(gated.code ? { code: gated.code } : {}),
        },
        { status: gated.statusCode ?? 401 },
      );
    }

    const loaded = await getStudyAggregateChecked(id, gated.context.kvClient);
    if (loaded.status === 'unavailable') {
      return NextResponse.json(
        { error: 'Analysis storage is temporarily unavailable.', retryable: true },
        { status: 503 },
      );
    }
    return NextResponse.json({ aggregate: loaded.status === 'found' ? loaded.aggregate : null });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/studies/[id]/aggregate',
      method: 'GET',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json({ error: 'Failed to fetch aggregate analysis' }, { status: 500 });
  }
}
