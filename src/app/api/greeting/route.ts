// POST /api/greeting - Get interview greeting
// Server-side only - API keys never sent to client
// Requires valid participant token to prevent quota abuse

import { NextResponse } from 'next/server';
import { getInterviewProvider } from '@/lib/providers';
import { verifyParticipantToken } from '@/lib/auth';
import { StudyConfig } from '@/types';

export async function POST(request: Request) {
  try {
    // Verify participant token
    const auth = await verifyParticipantToken(request);
    if (!auth.valid) {
      return NextResponse.json(
        { error: 'Valid participant token required' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { studyConfig } = body as { studyConfig: StudyConfig };

    // Validate required fields
    if (!studyConfig) {
      return NextResponse.json(
        { error: 'Missing required field: studyConfig' },
        { status: 400 }
      );
    }

    // Verify token's studyId matches the requested study (prevents token reuse across studies)
    // Skip for admin users (researchers previewing their studies)
    if (!auth.isAdmin && auth.studyId && studyConfig.id && auth.studyId !== studyConfig.id) {
      return NextResponse.json(
        { error: 'Token not valid for this study' },
        { status: 403 }
      );
    }

    // Get the configured AI provider (Gemini or Claude)
    // Priority: studyConfig.aiProvider > env.AI_PROVIDER > 'gemini'
    const provider = getInterviewProvider(studyConfig);

    // Generate greeting using the provider
    const greeting = await provider.getInterviewGreeting(studyConfig);

    return NextResponse.json({ greeting });
  } catch (error) {
    console.error('Greeting API error:', error);
    return NextResponse.json(
      { error: 'Failed to generate greeting' },
      { status: 500 }
    );
  }
}
