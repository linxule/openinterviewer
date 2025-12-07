// POST /api/synthesis - Synthesize interview patterns
// Server-side only - API keys never sent to client
// Requires valid participant token to prevent quota abuse

import { NextResponse } from 'next/server';
import { getInterviewProvider } from '@/lib/providers';
import { verifyParticipantToken } from '@/lib/auth';
import {
  StudyConfig,
  ParticipantProfile,
  InterviewMessage,
  BehaviorData
} from '@/types';

// Payload size limits to prevent abuse
const MAX_HISTORY_MESSAGES = 200; // Higher for synthesis - needs full interview
const MAX_CONTEXT_LENGTH = 10000;
const MAX_MESSAGE_LENGTH = 5000;

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
    let {
      history,
      studyConfig,
      behaviorData,
      participantProfile
    } = body as {
      history: InterviewMessage[];
      studyConfig: StudyConfig;
      behaviorData: BehaviorData;
      participantProfile: ParticipantProfile | null;
    };

    // Validate required fields
    if (!history || !studyConfig || !behaviorData) {
      return NextResponse.json(
        { error: 'Missing required fields: history, studyConfig, behaviorData' },
        { status: 400 }
      );
    }

    // Apply payload size limits
    history = history.slice(-MAX_HISTORY_MESSAGES).map(msg => ({
      ...msg,
      content: msg.content?.slice(0, MAX_MESSAGE_LENGTH) || ''
    }));
    if (participantProfile?.rawContext) {
      participantProfile = {
        ...participantProfile,
        rawContext: participantProfile.rawContext.slice(0, MAX_CONTEXT_LENGTH)
      };
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

    // Generate synthesis using the provider
    const result = await provider.synthesizeInterview(
      history,
      studyConfig,
      behaviorData,
      participantProfile
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error('Synthesis API error:', error);
    return NextResponse.json(
      { error: 'Failed to synthesize interview' },
      { status: 500 }
    );
  }
}
