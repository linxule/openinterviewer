// POST /api/interviews/save - Save completed interview
// Validates participant token or admin session for security
// Server-side validation ensures data integrity
// Idempotent: a completed interview is created once and then immutable.
// Exact retries are successful no-ops; conflicting reuse of an id is rejected.

import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { persistCompletedInterview } from '@/lib/kv';
import { getParticipantRequestContext } from '@/lib/researcherContext';
import { loadCanonicalStudy } from '@/lib/canonicalStudy';
import { StoredInterview } from '@/types';
import { validateInterviewSubmission } from '@/lib/interviewSubmission';
import { getParticipantRateLimitCounters } from '@/lib/rateLimit';
import { verifySynthesisReceipt } from '@/lib/synthesisReceipt';
import { verifyParticipantConsent, type ParticipantConsentRecord } from '@/lib/participantConsent';
import { readBoundedJsonObject } from '@/lib/requestBody';

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
    // Verify participant token or admin session and resolve researcher context
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
    } = await getParticipantRequestContext(request);
    if (!valid || !context) {
      return NextResponse.json(
        { error: error || 'Valid participant token or admin session required' },
        { status: statusCode ?? 401 }
      );
    }

    const parsedBody = await readBoundedJsonObject(request, 512_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Interview submission is too large.' : 'Interview submission is malformed.' },
        { status: parsedBody.status }
      );
    }
    const body = parsedBody.value;
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

    const { _receipt, ...verifiedSynthesis } = clientData.synthesis;
    const receiptValid = await verifySynthesisReceipt({
      receipt: _receipt,
      studyId: canonical.study.id,
      studyRevision: canonical.study.revision ?? 1,
      participantSessionId: isAdmin ? 'admin-preview' : participantSessionId!,
      transcript: clientData.transcript,
      participantProfile: clientData.participantProfile,
      behaviorData: clientData.behaviorData,
      synthesis: verifiedSynthesis,
    });
    if (!receiptValid) {
      return NextResponse.json({ error: 'Synthesis receipt is invalid or expired.' }, { status: 403 });
    }

    // Researcher preview exercises the real provider and canonical study, but
    // must never contaminate the participant dataset or lock/count the study.
    if (isAdmin) {
      return NextResponse.json({
        success: true,
        id: clientData.id,
        created: false,
        preview: true,
      });
    }

    const rateLimits = getParticipantRateLimitCounters(
      request,
      canonical.study.id,
      'save',
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
      synthesis: verifiedSynthesis,
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
      aiProvider: canonical.study.config.aiProvider || 'gemini',
      aiModel: canonical.study.config.aiModel,
      participantLinkId: linkId,
    };

    const fingerprint = submissionFingerprint({
      id: interviewId,
      studyId: canonical.study.id,
      participantProfile: clientData.participantProfile,
      transcript: clientData.transcript,
      synthesis: verifiedSynthesis,
      behaviorData: clientData.behaviorData,
      createdAt: clientData.createdAt ?? null,
      consentHash: consentRecord!.consentHash,
      consentAcceptedAt: consentRecord!.acceptedAt,
    });

    const persistence = await persistCompletedInterview(
      interview,
      fingerprint,
      {
        allowDisabledLinks: false,
        expectedStudyRevision: canonical.study.revision ?? 1,
        rateLimits,
      },
      context.kvClient
    );

    if (persistence.status === 'unavailable') {
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

    return NextResponse.json({
      success: true,
      id: interview.id,
      created: persistence.status === 'created',
    });
  } catch (error) {
    console.error('Save interview API error:', error);
    return NextResponse.json(
      { error: 'Failed to save interview' },
      { status: 500 }
    );
  }
}
