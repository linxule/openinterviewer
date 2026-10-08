// POST /api/transcribe?studyId=…&language=… - one voice clip to text.
// Participant or researcher-preview authority, like /api/interview. The body
// is a 16 kHz mono 16-bit WAV of at most 60 seconds (lib/transcription). The
// study must offer voice input through this installation ('installation'),
// the participant must have consented in the named language, and the request
// is admitted and charged before Workers AI is called once. Neither the audio
// nor the text is stored or logged.

import { NextResponse } from 'next/server';
import { resolveParticipantOrPreviewContext } from '@/lib/researcherContext';
import {
  loadCanonicalStudy,
  PARTICIPANT_INTERVIEW_HELD_COPY,
  participantContextRefusal,
  participantStoreAdmission,
  researcherPreviewHoldResponse,
} from '@/lib/canonicalStudy';
import { participantAdmissionRefusal } from '@/lib/rateLimit';
import { researcherAiBudgetResponse } from '@/lib/researcherAiBudget';
import { readBoundedBytes } from '@/lib/requestBody';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import { createRequestId, logRequestEvent, logRequestFailure } from '@/lib/requestLog';
import { isHostedMode } from '@/lib/mode';
import { consentTextFor } from '@/lib/i18n/languages';
import { participantLanguageFromBody } from '@/lib/i18n/participantLanguage';
import {
  isAcceptedVoiceClip,
  MAX_VOICE_BYTES,
  transcribeVoiceClip,
  voiceTranscriptionAvailable,
} from '@/lib/transcription/workersAi';

const ROUTE = '/api/transcribe';

function refusal(status: number, code: string, error: string, retryable = false) {
  return NextResponse.json({ error, code, ...(retryable ? { retryable: true } : {}) }, { status });
}

export async function POST(request: Request) {
  const notReady = deploymentNotReadyResponse(ROUTE);
  if (notReady) return notReady;
  const subrequest = participantAdmissionRefusal('transcribe');
  if (subrequest) return subrequest;
  try {
    if (isHostedMode()) return refusal(403, 'VOICE_NOT_ENABLED', 'Voice input is not offered on the hosted service.');
    const url = new URL(request.url);
    const studyIdParam = url.searchParams.get('studyId') ?? undefined;
    const languageParam = url.searchParams.get('language') ?? undefined;
    const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'audio/wav') return refusal(415, 'VOICE_FORMAT', 'Voice clips must be 16 kHz mono WAV.');

    const body = await readBoundedBytes(request, MAX_VOICE_BYTES);
    if (!body.ok) {
      return body.status === 413
        ? refusal(413, 'VOICE_TOO_LONG', 'Voice clips may be at most 60 seconds.')
        : refusal(400, 'VOICE_FORMAT', 'The voice clip could not be read.');
    }
    if (!isAcceptedVoiceClip(body.bytes)) return refusal(400, 'VOICE_FORMAT', 'Voice clips must be 16 kHz mono 16-bit WAV of at most 60 seconds.');

    const resolved = await resolveParticipantOrPreviewContext(request, { purpose: 'read', selectedStudyId: studyIdParam });
    const { valid, context, studyId, isAdmin, linkId, participantSessionId } = resolved;
    if (!valid || !context) {
      return participantContextRefusal(resolved, {
        route: ROUTE,
        error: 'Valid participant token required',
        held: PARTICIPANT_INTERVIEW_HELD_COPY,
      });
    }
    const canonical = await loadCanonicalStudy({
      store: context.store,
      tokenStudyId: studyId,
      legacyBodyStudyId: studyIdParam,
      isAdmin,
    });
    if (!canonical.ok) return canonical.response;
    const config = canonical.study.config;
    if (config.voiceInput !== 'installation') {
      return refusal(403, 'VOICE_NOT_ENABLED', 'This study does not offer voice transcription.');
    }
    const chosen = participantLanguageFromBody(config, languageParam === undefined ? {} : { language: languageParam });
    if (!chosen.ok) return chosen.response;

    if (!isAdmin) {
      if (!participantSessionId) {
        return NextResponse.json({ error: 'Participant session authority is incomplete.' }, { status: 401 });
      }
      // The consent notice named this processor; consent in this language is required.
      const consent = await context.store.verifyConsent({
        participantSessionId,
        studyId: canonical.study.id,
        studyRevision: canonical.study.revision ?? 1,
        consentText: consentTextFor(config, chosen.language),
        now: Date.now(),
      });
      if (consent.status === 'unavailable') {
        return NextResponse.json({ error: 'Unable to verify participant consent. Please try again.', retryable: true }, { status: 503 });
      }
      if (consent.status !== 'accepted') {
        return NextResponse.json({ error: 'Participant consent is required before using voice input.', code: 'CONSENT_REQUIRED' }, { status: 428 });
      }
      if (!voiceTranscriptionAvailable()) return refusal(503, 'VOICE_UNAVAILABLE', 'Voice transcription is not available right now.', true);
      const limited = await participantStoreAdmission({
        request,
        route: ROUTE,
        studyId: canonical.study.id,
        operation: 'transcribe',
        store: context.store,
        authority: { sessionId: participantSessionId, linkId, researcherId: context.researcherId },
      });
      if (limited) return limited;
    } else {
      const previewHeld = await researcherPreviewHoldResponse(context.store, ROUTE);
      if (previewHeld) return previewHeld;
      if (!voiceTranscriptionAvailable()) return refusal(503, 'VOICE_UNAVAILABLE', 'Voice transcription is not available right now.', true);
      const budgetLimited = await researcherAiBudgetResponse(request, 'transcribe', context.store, ROUTE);
      if (budgetLimited) return budgetLimited;
    }

    const outcome = await transcribeVoiceClip(body.bytes, chosen.language);
    if (!outcome.ok) {
      logRequestEvent({ event: 'route.failure', route: ROUTE, method: 'POST', reason: outcome.reason });
      return outcome.reason === 'unavailable'
        ? refusal(503, 'VOICE_UNAVAILABLE', 'Voice transcription is not available right now.', true)
        : refusal(502, 'VOICE_FAILED', 'The recording could not be transcribed. Please try again or type your answer.', true);
    }
    return NextResponse.json({ text: outcome.text }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: ROUTE,
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json({ error: 'Failed to transcribe the recording.' }, { status: 500 });
  }
}
