// POST /api/interviews/[id]/analyze?studyId=... - Researcher-triggered
// interview analysis (slice P). The recovery path for everything the
// deferred after() run in save/route.ts could not finish, and the only way
// to analyze an interview that was never deferred (e.g. legacy pending
// records). One interview per press; StudyDetail's batch action calls this
// route sequentially, never a server-side batch (P8.2).

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { getInterviewChecked } from '@/lib/kv';
import {
  getAuthorizedResearcherStudyContext,
  providerKeysFromContext,
} from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { loadCanonicalStudy } from '@/lib/canonicalStudy';
import { mapInterviewLoad } from '@/lib/ownedStudies';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { runInterviewAnalysis } from '@/lib/interviewAnalysis';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

const STUDY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Missing interview ID' }, { status: 400 });
    }

    // Required in both modes, unlike the plain GET: authority is per-study,
    // and an analyze request with no study to gate on has nothing to check.
    const studyId = new URL(request.url).searchParams.get('studyId');
    if (!studyId || !STUDY_ID_PATTERN.test(studyId)) {
      return NextResponse.json({ error: 'Missing or invalid study ID' }, { status: 400 });
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
    // Cross-tenant refusal, same as the plain GET (interviews/[id]/route.ts).
    if (mapped.interview.studyId !== studyId) {
      return NextResponse.json({ error: 'Interview not found' }, { status: 404 });
    }

    const canonical = await loadCanonicalStudy({
      kvClient: gated.context.kvClient,
      tokenStudyId: studyId,
      isAdmin: true,
    });
    if (!canonical.ok) return canonical.response;

    const platformLimited = await hostedAiRateLimitResponse(
      request,
      'analysis',
      { researcherId: gated.researcherId },
    );
    if (platformLimited) return platformLimited;

    const outcome = await runInterviewAnalysis({
      interviewId: id,
      study: canonical.study,
      kvClient: gated.context.kvClient,
      providerKeys: providerKeysFromContext(gated.context),
      platformAuthority: { researcherId: gated.researcherId },
    });

    // A failed analysis is a successful report of a failure: the researcher
    // is being told a record fact, not a provider fact. 200 for all four.
    // `not-found` only arises from a race between the tenancy check above
    // and the claim itself (the interview vanished mid-request); it is
    // reported as `busy` rather than growing the response's status enum.
    if (outcome.status === 'failed') {
      return NextResponse.json({ status: 'failed', failureKind: outcome.failureKind });
    }
    return NextResponse.json({ status: outcome.status === 'not-found' ? 'busy' : outcome.status });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/interviews/[id]/analyze',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to analyze interview' },
      { status: 500 }
    );
  }
}
