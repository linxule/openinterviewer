// POST /api/interviews/save - Save completed interview
// Validates participant token or admin session for security
// Server-side validation ensures data integrity
// Idempotent: a completed interview is created once and then immutable.
// Exact retries are successful no-ops; conflicting reuse of an id is rejected.
//
// Slice P — save first, analyze later. The transcript is durable the moment
// the participant finishes: this route persists with `synthesis: null` and
// `analysis: { status: 'pending', ... }` and never waits on a provider call.
// A successful, newly-created save schedules the deferred analysis via
// `after()`; the researcher-triggered `POST /api/interviews/[id]/analyze` is
// the recovery path for everything that run cannot finish.

export const maxDuration = 120;

import { createHash } from 'crypto';
import { after, NextResponse } from 'next/server';
import {
  INTERVIEW_PERSISTING_PREFIX,
  parsePersistingGuard,
  persistCompletedInterview,
} from '@/lib/kv';
import {
  providerKeysFromContext,
  resolveParticipantOrPreviewContext,
  selectedStudyIdFromParticipantBody,
} from '@/lib/researcherContext';
import { loadCanonicalStudy } from '@/lib/canonicalStudy';
import { StoredInterview } from '@/types';
import { validateInterviewSubmission } from '@/lib/interviewSubmission';
import { getSavePersistRatePlan } from '@/lib/rateLimit';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { runInterviewAnalysis } from '@/lib/interviewAnalysis';
import { verifyParticipantConsent, type ParticipantConsentRecord } from '@/lib/participantConsent';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function submissionFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export async function POST(request: Request) {
  try {
    const parsedBody = await readBoundedJsonObject(request, 512_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Interview submission is too large.' : 'Interview submission is malformed.' },
        { status: parsedBody.status }
      );
    }
    const body = parsedBody.value;
    const selectedStudyId = selectedStudyIdFromParticipantBody(body);

    const {
      valid,
      context,
      studyId,
      isAdmin,
      error,
      statusCode,
      linkId,
      participantSessionId,
      studyRevision,
      persistRepairOnly,
    } = await resolveParticipantOrPreviewContext(request, {
      purpose: 'new-persist',
      selectedStudyId,
    });
    if (!valid || !context) {
      return NextResponse.json(
        { error: error || 'Valid participant token or admin session required' },
        { status: statusCode ?? 401 }
      );
    }
    let clientData;
    try {
      clientData = validateInterviewSubmission(body);
    } catch {
      return NextResponse.json({ error: 'Interview submission is malformed or exceeds allowed limits.' }, { status: 400 });
    }

    // A participant token is the study authority. A body id is only a
    // consistency assertion; authenticated researcher previews may select a
    // saved study by body id.
    if (!isAdmin && clientData.studyId && studyId !== clientData.studyId) {
      return NextResponse.json(
        { error: 'Study ID mismatch - token is for a different study' },
        { status: 403 }
      );
    }

    if (isAdmin && !clientData.studyId) {
      return NextResponse.json(
        { error: 'Missing required fields: id, transcript, and studyId for researcher preview' },
        { status: 400 }
      );
    }

    if (!isAdmin && (!participantSessionId || !linkId || studyRevision === undefined)) {
      return NextResponse.json({ error: 'Participant session authority is incomplete.' }, { status: 401 });
    }

    const canonical = await loadCanonicalStudy({
      kvClient: context.kvClient,
      tokenStudyId: studyId,
      legacyBodyStudyId: clientData.studyId,
      isAdmin,
    });
    if (!canonical.ok) return canonical.response;

    let consentRecord: ParticipantConsentRecord | null = null;
    if (!isAdmin) {
      const consent = await verifyParticipantConsent(
        {
          participantSessionId: participantSessionId!,
          studyId: canonical.study.id,
          studyRevision: canonical.study.revision ?? 1,
          consentText: canonical.study.config.consentText || '',
        },
        context.kvClient
      );
      if (consent.status === 'unavailable') {
        return NextResponse.json(
          { error: 'Unable to verify participant consent. Interview not saved. Please try again.', retryable: true },
          { status: 503 }
        );
      }
      if (consent.status !== 'accepted') {
        return NextResponse.json(
          { error: 'Verified participant consent is required before saving.', code: 'CONSENT_REQUIRED' },
          { status: 428 }
        );
      }
      consentRecord = consent.consent;
    }

    // Researcher preview exercises the real provider (via /api/synthesis) and
    // the canonical study, but must never contaminate the participant dataset
    // or lock/count the study. Nothing above needed the body's synthesis
    // field — the researcher preview has no receipt to verify and no record
    // to write, so it returns before either.
    if (isAdmin) {
      return NextResponse.json({
        success: true,
        id: clientData.id,
        created: false,
        preview: true,
      });
    }

    const rateLimits = getSavePersistRatePlan(
      request,
      canonical.study.id,
      { sessionId: participantSessionId, linkId, researcherId: context.researcherId }
    );
    if (!rateLimits) {
      return NextResponse.json({ error: 'Participant request authority is incomplete.' }, { status: 401 });
    }

    // Build the interview with server-controlled identity and timestamps.
    const now = Date.now();
    const interviewId = `session-${participantSessionId}`;
    const defaultProfile = {
      id: interviewId,
      fields: [],
      rawContext: '',
      timestamp: now
    };
    const interview: StoredInterview = {
      id: interviewId,
      studyId: canonical.study.id,
      studyName: canonical.study.config.name,
      participantProfile: clientData.participantProfile || defaultProfile,
      transcript: clientData.transcript,
      // A participant save carries no synthesis: the analysis is a second,
      // retryable, researcher-owned act performed entirely on the server.
      // No aiProvider/aiModel/requestedAiModel/routedProvider either — this
      // record has not been analyzed yet. They are written by the analysis
      // writer, once, when it succeeds.
      synthesis: null,
      behaviorData: clientData.behaviorData,
      // Server-controlled timestamps - don't trust client-provided values
      // Accept client createdAt only if in the past and within 30 days
      createdAt: clientData.createdAt && clientData.createdAt < now && clientData.createdAt > now - 30 * 24 * 60 * 60 * 1000
        ? clientData.createdAt
        : now,
      completedAt: now,  // Always server-generated
      status: 'completed',  // Always set by server
      studyRevision: canonical.study.revision ?? 1,
      consentHash: consentRecord!.consentHash,
      consentAcceptedAt: consentRecord!.acceptedAt,
      // The researcher's own choice, at the revision this session is pinned
      // to. Never from the body: see interviewSubmission.ts's explicit field
      // copy, which drops any client-asserted conducting model.
      conductedByProvider: canonical.study.config.aiProvider,
      conductedByModel: canonical.study.config.aiModel,
      analysis: { status: 'pending', attempts: 0, lastAttemptAt: now },
      participantLinkId: linkId,
    };

    // The fingerprint is the identity of the SUBMISSION. It must not cover
    // `analysis` or `synthesis`: the analysis is written later, by a
    // different actor, possibly several times, and a `persist-repair` retry
    // arriving after a successful analysis must still recognize its own
    // earlier attempt.
    const fingerprint = submissionFingerprint({
      id: interviewId,
      studyId: canonical.study.id,
      participantProfile: clientData.participantProfile,
      transcript: clientData.transcript,
      behaviorData: clientData.behaviorData,
      createdAt: clientData.createdAt ?? null,
      consentHash: consentRecord!.consentHash,
      consentAcceptedAt: consentRecord!.acceptedAt,
      conductedByProvider: canonical.study.config.aiProvider,
      conductedByModel: canonical.study.config.aiModel,
    });

    if (persistRepairOnly) {
      let storedGuard: ReturnType<typeof parsePersistingGuard> = null;
      try {
        storedGuard = parsePersistingGuard(
          await context.kvClient.get(`${INTERVIEW_PERSISTING_PREFIX}${interviewId}`)
        );
      } catch (error) {
        logRequestFailure({
      event: 'route.failure',
      route: '/api/interviews/save',
      method: 'POST',
      status: 503,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
        return NextResponse.json(
          { error: 'Storage is temporarily unavailable. Interview not saved. Please try again.', retryable: true },
          { status: 503 }
        );
      }
      if (
        !storedGuard
        || storedGuard.interviewId !== interviewId
        || storedGuard.studyId !== canonical.study.id
        || storedGuard.fingerprint !== fingerprint
        || storedGuard.identity.participantSessionId !== participantSessionId
        || storedGuard.identity.linkId !== linkId
      ) {
        return NextResponse.json({ error: 'This study is no longer active.' }, { status: 404 });
      }
    }

    const persistence = await persistCompletedInterview(
      interview,
      fingerprint,
      {
        allowDisabledLinks: false,
        expectedStudyRevision: canonical.study.revision ?? 1,
        rateLimits,
        identity: {
          participantSessionId: participantSessionId ?? null,
          linkId: linkId ?? null,
        },
      },
      context.kvClient
    );

    if (persistence.status === 'unavailable' || persistence.status === 'ambiguous' || persistence.status === 'persist-guard') {
      return NextResponse.json(
        { error: 'Storage is temporarily unavailable. Interview not saved. Please try again.', retryable: true },
        { status: 503 }
      );
    }
    if (persistence.status === 'conflict') {
      return NextResponse.json(
        { error: 'An interview with this id already exists with different content.' },
        { status: 409 }
      );
    }
    if (persistence.status === 'study-not-found') {
      return NextResponse.json({ error: 'This study is no longer active.' }, { status: 404 });
    }
    if (persistence.status === 'links-disabled') {
      return NextResponse.json(
        { error: 'Participant links have been disabled for this study.' },
        { status: 403 }
      );
    }
    if (persistence.status === 'revision-stale') {
      return NextResponse.json(
        { error: 'This study changed before the interview could be saved. Restart with the latest study link.' },
        { status: 409 }
      );
    }
    if (persistence.status === 'rate-limited') {
      return NextResponse.json(
        { error: 'Too many save attempts. Please wait before trying again.', retryable: true },
        { status: 429, headers: { 'Retry-After': '3600' } }
      );
    }

    // Deferred work is scheduled ONLY on `created` — never on `duplicate`,
    // and never on any refusal — so a retrying participant cannot schedule a
    // second run. The claim CAS inside runInterviewAnalysis is still the
    // real concurrency gate; this is just the common case's first attempt.
    if (persistence.status === 'created') {
      const kvClient = context.kvClient;
      const study = canonical.study;
      const providerKeys = providerKeysFromContext(context);
      const analysisParticipantSessionId = participantSessionId;
      const researcherId = context.researcherId;
      after(async () => {
        // The same hosted platform budget the participant-triggered call
        // consumed before this slice — one save, one analysis, inside the
        // existing budget. A rate-limited or unavailable check simply skips
        // scheduling this attempt; the interview stays `pending` and the
        // researcher's "Run analysis" (a separate budget) recovers it.
        const platformLimited = await hostedAiRateLimitResponse(
          request,
          'synthesis',
          { researcherId, participantSessionId: analysisParticipantSessionId }
        );
        if (platformLimited) return;
        await runInterviewAnalysis({
          interviewId: interview.id,
          study,
          kvClient,
          providerKeys,
          platformAuthority: { researcherId, participantSessionId: analysisParticipantSessionId },
        });
      });
    }

    return NextResponse.json({
      success: true,
      id: interview.id,
      created: persistence.status === 'created',
      ...(persistence.status === 'duplicate' ? { duplicate: true } : {}),
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/interviews/save',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to save interview' },
      { status: 500 }
    );
  }
}
