import { NextResponse } from 'next/server';
import {
  loadCanonicalStudy,
  PARTICIPANT_CONSENT_HELD_COPY,
  participantContextRefusal,
  workspaceHeldResponse,
} from '@/lib/canonicalStudy';
import {
  resolveParticipantOrPreviewContext,
  selectedStudyIdFromParticipantBody,
} from '@/lib/researcherContext';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import {
  currentProviderTransport,
  disclosedMember,
  providerNotConfiguredResponse,
} from '@/lib/transportDisclosure';

const ROUTE = '/api/consent';

export async function POST(request: Request) {
  const notReady = deploymentNotReadyResponse(ROUTE);
  if (notReady) return notReady;
  try {
    const parsedBody = await readBoundedJsonObject(request, 1_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Consent request is too large.' : 'Consent request is malformed.' },
        { status: parsedBody.status }
      );
    }
    const assertedStudyId = selectedStudyIdFromParticipantBody(parsedBody.value);

    const resolved = await resolveParticipantOrPreviewContext(request, {
      purpose: 'read',
      selectedStudyId: assertedStudyId,
    });
    const { valid, context, studyId, study, studyRevision, participantSessionId, isAdmin } = resolved;
    if (!valid || !context) {
      return participantContextRefusal(resolved, {
        route: ROUTE,
        error: 'A valid participant or researcher preview session is required.',
        held: PARTICIPANT_CONSENT_HELD_COPY,
      });
    }

    // Preview records are deliberately ephemeral: the authenticated researcher
    // exercises the same transition without writing participant consent data.
    if (isAdmin) {
      const canonical = await loadCanonicalStudy({
        store: context.store,
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

    // Cloudflare (D9): the page states where responses are sent, and the
    // browser echoes the transport it rendered. Consent is recorded only for
    // the transport this study uses now; a page rendered for another route
    // (including an older page that sends none) must be reopened.
    const current = currentProviderTransport(context, study.config.aiProvider);
    let disclosure: { disclosedTransport?: 'cloudflare-gateway' } = {};
    if (current.applies) {
      if (!current.ok) return providerNotConfiguredResponse();
      if (parsedBody.value.disclosedTransport !== current.transport) {
        return NextResponse.json(
          {
            code: 'DISCLOSURE_CHANGED',
            error: 'How this study sends your responses has changed since this page loaded. Reopen the study link to review the updated notice.',
          },
          { status: 409 }
        );
      }
      disclosure = disclosedMember(current.transport);
    }

    const recorded = await context.store.recordConsent({
      participantSessionId,
      // Bind the record to the canonical object loaded while authenticating
      // this request, rather than treating duplicated token claims as the
      // final source of study identity or revision.
      studyId: study.id,
      studyRevision: study.revision ?? 1,
      consentText: study.config.consentText || '',
      ...disclosure,
      now: Date.now(),
    });
    if (recorded.status === 'held') {
      return workspaceHeldResponse({ route: ROUTE, reason: recorded.reason, ...PARTICIPANT_CONSENT_HELD_COPY });
    }
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
