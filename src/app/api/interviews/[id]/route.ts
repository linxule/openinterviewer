// GET /api/interviews/[id] - Get single interview
// Protected: Requires authenticated session

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getInterviewChecked } from '@/lib/kv';
import {
  getAuthorizedResearcherStudyContext,
  getRequestContext,
} from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { isHostedMode } from '@/lib/mode';
import { mapInterviewLoad } from '@/lib/ownedStudies';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

const STUDY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: 'Missing interview ID' },
        { status: 400 }
      );
    }

    const studyId = new URL(request.url).searchParams.get('studyId');
    if (isHostedMode()) {
      if (!studyId || !STUDY_ID_PATTERN.test(studyId)) {
        return NextResponse.json(
          { error: 'Missing or invalid study ID' },
          { status: 400 }
        );
      }
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

      const loaded = await getInterviewChecked(id, gated.context.kvClient);
      const mapped = mapInterviewLoad(loaded);
      if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
      if (mapped.interview.studyId !== studyId) {
        return NextResponse.json({ error: 'Interview not found' }, { status: 404 });
      }
      return NextResponse.json({ interview: mapped.interview });
    }

    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const loaded = await getInterviewChecked(id, context.kvClient);
    const mapped = mapInterviewLoad(loaded);
    if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
    if (studyId && mapped.interview.studyId !== studyId) {
      return NextResponse.json({ error: 'Interview not found' }, { status: 404 });
    }
    return NextResponse.json({ interview: mapped.interview });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/interviews/[id]',
      method: 'GET',
      status: 503,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to fetch interview' },
      { status: 503 }
    );
  }
}
