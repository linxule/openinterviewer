// Client-side service that calls API routes
// API keys are kept server-side - this file runs in the browser

import {
  StudyConfig,
  ParticipantProfile,
  InterviewMessage,
  SynthesisResult,
  BehaviorData,
  AIInterviewResponse,
  QuestionProgress
} from '@/types';
import { logRequestFailure } from '@/lib/requestLog';
import { buildParticipantOrPreviewHeaders } from '@/services/participantHeaders';

// Participant authority is a short-lived HttpOnly same-site cookie. Share-link
// codes and session credentials are never exposed to this JavaScript service.

// Thrown for any non-OK API response so callers can distinguish a rate limit
// (429, with a server-provided Retry-After) from every other failure without
// parsing the message string.
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterSeconds: number | null
  ) {
    super(`API error: ${status}`);
    this.name = 'ApiRequestError';
  }
}

function retryAfterSecondsFromResponse(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// Generate AI interviewer response
export const generateInterviewResponse = async (
  history: InterviewMessage[],
  studyConfig: StudyConfig,
  participantProfile: ParticipantProfile | null,
  questionProgress: QuestionProgress,
  currentContext: string,
  researcherPreview = false,
  participantSessionHandle?: string | null
): Promise<AIInterviewResponse> => {
  try {
    const response = await fetch('/api/interview', {
      method: 'POST',
      headers: buildParticipantOrPreviewHeaders({
        researcherPreview,
        participantSessionHandle,
      }),
      body: JSON.stringify({
        history,
        studyConfig,
        participantProfile,
        questionProgress,
        currentContext
      })
    });

    if (!response.ok) {
      throw new ApiRequestError(response.status, retryAfterSecondsFromResponse(response));
    }

    return await response.json();
  } catch (error) {
    logRequestFailure({ event: 'route.failure' }, error);
    throw error;
  }
};

// Get initial interview greeting
export const getInterviewGreeting = async (
  studyConfig: StudyConfig,
  researcherPreview = false,
  participantSessionHandle?: string | null
): Promise<string> => {
  try {
    const response = await fetch('/api/greeting', {
      method: 'POST',
      headers: buildParticipantOrPreviewHeaders({
        researcherPreview,
        participantSessionHandle,
      }),
      body: JSON.stringify({ studyConfig })
    });

    if (!response.ok) {
      throw new ApiRequestError(response.status, retryAfterSecondsFromResponse(response));
    }

    const data = await response.json();
    return data.greeting;
  } catch (error) {
    logRequestFailure({ event: 'route.failure' }, error);
    throw error;
  }
};

// Synthesize interview patterns
export const synthesizeInterview = async (
  history: InterviewMessage[],
  studyConfig: StudyConfig,
  behaviorData: BehaviorData,
  participantProfile: ParticipantProfile | null,
  researcherPreview = false,
  participantSessionHandle?: string | null
): Promise<SynthesisResult> => {
  try {
    const response = await fetch('/api/synthesis', {
      method: 'POST',
      headers: buildParticipantOrPreviewHeaders({
        researcherPreview,
        participantSessionHandle,
      }),
      body: JSON.stringify({
        history,
        studyConfig,
        behaviorData,
        participantProfile
      })
    });

    if (!response.ok) {
      throw new ApiRequestError(response.status, retryAfterSecondsFromResponse(response));
    }

    return await response.json();
  } catch (error) {
    logRequestFailure({ event: 'route.failure' }, error);
    throw error;
  }
};
