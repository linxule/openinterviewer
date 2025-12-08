// POST /api/studies/[id]/generate-followup - Generate follow-up study from synthesis
// Server-side only - requires authenticated session
// Uses AI to suggest new research questions based on findings

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getInterviewProvider } from '@/lib/providers';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import { getStudy, isKVAvailable } from '@/lib/kv';
import { AggregateSynthesisResult, StudyConfig } from '@/types';

// Verify admin session
async function verifyAuth() {
  const cookieStore = await cookies();
  const authCookie = cookieStore.get(SESSION_COOKIE_NAME);

  if (!authCookie?.value) {
    return { authorized: false, error: 'Unauthorized' };
  }

  const isValid = await verifySessionToken(authCookie.value);
  if (!isValid) {
    return { authorized: false, error: 'Session expired or invalid' };
  }

  return { authorized: true };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Verify researcher authentication
    const auth = await verifyAuth();
    if (!auth.authorized) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { id: studyId } = await params;

    // Check KV availability
    const kvAvailable = await isKVAvailable();
    if (!kvAvailable) {
      return NextResponse.json(
        { error: 'Storage not configured' },
        { status: 503 }
      );
    }

    // Fetch parent study
    const parentStudy = await getStudy(studyId);
    if (!parentStudy) {
      return NextResponse.json(
        { error: 'Study not found' },
        { status: 404 }
      );
    }

    // Parse request body - expects synthesis data
    const body = await request.json();
    const { synthesis } = body as { synthesis: AggregateSynthesisResult };

    if (!synthesis || !synthesis.keyFindings?.length) {
      return NextResponse.json(
        { error: 'Missing or invalid synthesis data' },
        { status: 400 }
      );
    }

    // Get the configured AI provider
    // Priority: studyConfig.aiProvider > env.AI_PROVIDER > 'gemini'
    const provider = getInterviewProvider(parentStudy.config);

    // Generate follow-up study suggestions
    const suggestions = await provider.generateFollowupStudy(
      parentStudy.config,
      synthesis
    );

    // Build pre-filled config for follow-up study
    // AI generates: name, researchQuestion, coreQuestions
    // Deterministic: topicAreas from commonThemes
    // Copied: profileSchema, aiBehavior, consentText
    // Linked: parentStudyId, parentStudyName
    const followUpConfig: Partial<StudyConfig> = {
      name: suggestions.name,
      description: `Follow-up study based on "${parentStudy.config.name}"`,
      researchQuestion: suggestions.researchQuestion,
      coreQuestions: suggestions.coreQuestions,
      // Extract topics from common themes if available
      topicAreas: synthesis.commonThemes?.length > 0
        ? synthesis.commonThemes.slice(0, 5).map(t => t.theme)
        : parentStudy.config.topicAreas,
      // Copy from parent
      profileSchema: parentStudy.config.profileSchema,
      aiBehavior: parentStudy.config.aiBehavior,
      consentText: parentStudy.config.consentText,
      // Inherit AI settings
      aiProvider: parentStudy.config.aiProvider,
      aiModel: parentStudy.config.aiModel,
      enableReasoning: parentStudy.config.enableReasoning,
      // Link to parent
      parentStudyId: parentStudy.id,
      parentStudyName: parentStudy.config.name,
      generatedFrom: 'synthesis'
    };

    return NextResponse.json({
      followUpConfig,
      parentStudy: {
        id: parentStudy.id,
        name: parentStudy.config.name
      }
    });
  } catch (error) {
    console.error('Generate follow-up API error:', error);
    return NextResponse.json(
      { error: 'Failed to generate follow-up study' },
      { status: 500 }
    );
  }
}
