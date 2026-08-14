// GET /api/interviews - List all interviews (or filter by studyId)
// Protected: Requires authenticated session

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getAllInterviewsChecked, getStudyInterviewsChecked } from '@/lib/kv';
import { getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';

export async function GET(request: Request) {
  try {
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    // Check for studyId filter
    const { searchParams } = new URL(request.url);
    const studyId = searchParams.get('studyId');

    // Get interviews (filtered by study or all)
    const loaded = studyId
      ? await getStudyInterviewsChecked(studyId, context.kvClient, 1_000)
      : await getAllInterviewsChecked(context.kvClient, 1_000);

    if (loaded.status === 'unavailable') {
      return NextResponse.json(
        { error: 'Interview storage is temporarily unavailable.', retryable: true },
        { status: 503 }
      );
    }
    if (loaded.status === 'too-large') {
      return NextResponse.json(
        { error: 'This interview list is too large to load at once. Narrow it by study.' },
        { status: 413 }
      );
    }

    return NextResponse.json({ interviews: loaded.items });
  } catch (error) {
    console.error('Interviews API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch interviews' },
      { status: 503 }
    );
  }
}
