// GET /api/interviews - List interviews for owned studies (or filter by studyId)
// Protected: Requires authenticated session

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getAllInterviewsChecked, getStudyInterviewsChecked } from '@/lib/kv';
import {
  getAuthorizedResearcherStudyContext,
  getHostedResearcherIdentity,
  getRequestContext,
} from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { isHostedMode } from '@/lib/mode';
import {
  inspectOwnedStudyGates,
  loadAllowedInterviews,
  mapCollectionLoad,
} from '@/lib/ownedStudies';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

export async function GET(request: Request) {
  try {
    const studyId = new URL(request.url).searchParams.get('studyId');

    if (studyId) {
      const gated = await getAuthorizedResearcherStudyContext(studyId, 'read');
      const denied = configurationRequiredResponse(gated);
      if (denied) return denied;
      if (!gated.authorized || !gated.context) {
        return NextResponse.json(
          {
            error: gated.error || 'Unauthorized',
            retryable: gated.retryable,
            ...(gated.code ? { code: gated.code } : {}),
            ...(gated.reason ? { reason: gated.reason } : {}),
          },
          { status: gated.statusCode ?? 401 },
        );
      }
      const loaded = await getStudyInterviewsChecked(studyId, gated.context.kvClient, 1_000);
      const mapped = mapCollectionLoad(loaded, {
        unavailable: 'Interview storage is temporarily unavailable.',
        tooLarge: 'This interview list is too large to load at once. Narrow it by study.',
      });
      if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
      return NextResponse.json({ interviews: mapped.items });
    }

    if (isHostedMode()) {
      const identity = await getHostedResearcherIdentity();
      if (!identity.authorized || !identity.researcherId) {
        return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
      }
      const inspection = await inspectOwnedStudyGates(identity.researcherId);
      const inspectionMapped = mapCollectionLoad(
        inspection.status === 'ok'
          ? { status: 'ok', items: [], pendingStudies: inspection.pendingStudies }
          : inspection,
        {
          unavailable: 'Interview storage is temporarily unavailable.',
          tooLarge: 'This interview list is too large to load at once. Narrow it by study.',
        },
      );
      if (!inspectionMapped.ok) {
        return NextResponse.json(inspectionMapped.body, { status: inspectionMapped.status });
      }
      if (inspection.status !== 'ok' || inspection.allowedIds.length === 0) {
        return NextResponse.json({
          interviews: [],
          pendingStudies: inspectionMapped.pendingStudies,
        });
      }

      const access = await getRequestContext();
      const setupResponse = configurationRequiredResponse(access);
      if (setupResponse) return setupResponse;
      if (!access.authorized || !access.context) {
        return NextResponse.json({ error: access.error || 'Unauthorized' }, { status: 401 });
      }
      const loaded = await loadAllowedInterviews(inspection.allowedIds, access.context.kvClient, 1_000);
      const mapped = mapCollectionLoad(loaded, {
        unavailable: 'Interview storage is temporarily unavailable.',
        tooLarge: 'This interview list is too large to load at once. Narrow it by study.',
      });
      if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
      return NextResponse.json({
        interviews: mapped.items,
        pendingStudies: inspection.pendingStudies,
      });
    }

    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const loaded = await getAllInterviewsChecked(context.kvClient, 1_000);
    const mapped = mapCollectionLoad(loaded, {
      unavailable: 'Interview storage is temporarily unavailable.',
      tooLarge: 'This interview list is too large to load at once. Narrow it by study.',
    });
    if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
    return NextResponse.json({ interviews: mapped.items });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/interviews',
      method: 'GET',
      status: 503,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to fetch interviews' },
      { status: 503 }
    );
  }
}
