import { NextResponse } from 'next/server';
import { loadCanonicalStudy } from '@/lib/canonicalStudy';
import { recordParticipantConsent } from '@/lib/participantConsent';
import {
  resolveParticipantOrPreviewContext,
  selectedStudyIdFromParticipantBody,
} from '@/lib/researcherContext';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

export async function POST(request: Request) {
  try {
    const parsedBody = await readBoundedJsonObject(request, 1_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Consent request is too large.' : 'Consent request is malformed.' },
        { status: parsedBody.status }
      );
    }
    const assertedStudyId = selectedStudyIdFromParticipantBody(parsedBody.value);

    const {
      valid,
      context,
      studyId,
      study,
      studyRevision,
      participantSessionId,
      isAdmin,
      error,
      statusCode,
    } = await resolveParticipantOrPreviewContext(request, {
      purpose: 'read',
      selectedStudyId: assertedStudyId,
    });
    if (!valid || !context) {
      return NextResponse.json(
        { error: error || 'A valid participant or researcher preview session is required.' },
        { status: statusCode ?? 401 }
      );
    }

    // Preview records are deliberately ephemeral: the authenticated researcher
    // exercises the same transition without writing participant consent data.
    if (isAdmin) {
      const canonical = await loadCanonicalStudy({
        kvClient: context.kvClient,
        legacyBodyStudyId: assertedStudyId,
        isAdmin: true,
      });
      if (!canonical.ok) return canonical.response;
      return NextResponse.json({
        success: true,
        preview: true,
        acceptedAt: Date.now(),
      });
    }

    if (!studyId || !study || !participantSessionId || studyRevision === undefined) {
      return NextResponse.json(
        { error: 'Participant session authority is incomplete.' },
        { status: 401 }
      );
    }
    if (assertedStudyId && assertedStudyId !== studyId) {
      return NextResponse.json(
        { error: 'Study ID mismatch - participant session is for a different study.' },
        { status: 403 }
      );
    }

    const recorded = await recordParticipantConsent(
      {
        participantSessionId,
        // Bind the record to the canonical object loaded while authenticating
        // this request, rather than treating duplicated token claims as the
        // final source of study identity or revision.
        studyId: study.id,
        studyRevision: study.revision ?? 1,
        consentText: study.config.consentText || '',
      },
      context.kvClient
    );
    if (recorded.status === 'unavailable') {
      return NextResponse.json(
        { error: 'Consent storage is temporarily unavailable. Please try again.', retryable: true },
        { status: 503 }
      );
    }
    if (recorded.status === 'conflict') {
      return NextResponse.json(
        { error: 'This participant session no longer matches the study consent. Reopen the study link.' },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      preview: false,
      acceptedAt: recorded.consent.acceptedAt,
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/consent',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to record participant consent.' },
      { status: 500 }
    );
  }
}
