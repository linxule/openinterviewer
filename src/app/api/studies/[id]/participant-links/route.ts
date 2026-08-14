// Researcher-only opaque participant-link management for one canonical study.
// GET returns metadata only; DELETE revokes one hashed link ID atomically.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { Redis } from '@upstash/redis';
import { getStudyChecked } from '@/lib/kv';
import { isHostedMode } from '@/lib/mode';
import {
  listParticipantLinksForStudy,
  revokeParticipantLink,
} from '@/lib/participantLinks';
import { getStudyOwnerChecked } from '@/lib/platformDb';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { getRequestContext } from '@/lib/researcherContext';

const STUDY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const LINK_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_DELETE_BODY_BYTES = 4_096;

type StudyLinkAccess =
  | { ok: true; studyId: string; researcherId: string | null; standaloneClient: Redis }
  | { ok: false; response: NextResponse };

async function authorizeStudyLinkAccess(studyId: string): Promise<StudyLinkAccess> {
  const access = await getRequestContext();
  const setupResponse = configurationRequiredResponse(access);
  if (setupResponse) return { ok: false, response: setupResponse };
  if (!access.authorized || !access.context) {
    return {
      ok: false,
      response: NextResponse.json({ error: access.error || 'Unauthorized' }, { status: 401 }),
    };
  }
  if (!STUDY_ID_PATTERN.test(studyId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid study ID' }, { status: 400 }),
    };
  }

  // Both modes require a real canonical BYOS/standalone study record. A link
  // index alone is never authority to inspect or mutate a study's links.
  const loaded = await getStudyChecked(studyId, access.context.kvClient);
  if (loaded.status === 'unavailable') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Study storage is temporarily unavailable', retryable: true },
        { status: 503 }
      ),
    };
  }
  if (loaded.status === 'not-found') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Study not found' }, { status: 404 }),
    };
  }

  const hosted = isHostedMode();
  const researcherId = hosted ? (access.researcherId ?? null) : null;
  if (hosted) {
    if (!researcherId) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'Researcher identity is required' }, { status: 401 }),
      };
    }
    const owner = await getStudyOwnerChecked(studyId);
    if (owner.status === 'unavailable') {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Unable to verify study ownership', retryable: true },
          { status: 503 }
        ),
      };
    }
    if (owner.status !== 'found' || owner.researcherId !== researcherId) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'Study ownership does not match this account' }, { status: 403 }),
      };
    }
  }

  return {
    ok: true,
    studyId,
    researcherId,
    standaloneClient: access.context.kvClient,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  void request;
  const { id } = await params;
  const access = await authorizeStudyLinkAccess(id);
  if (!access.ok) return access.response;

  const result = await listParticipantLinksForStudy({
    studyId: access.studyId,
    researcherId: access.researcherId,
    standaloneClient: access.standaloneClient,
    maximum: 1_000,
  });
  if (result.status !== 'ok') {
    return NextResponse.json(
      { error: 'Participant link service is temporarily unavailable', retryable: true },
      { status: 503 }
    );
  }

  return NextResponse.json(
    { links: result.links, truncated: result.truncated },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await authorizeStudyLinkAccess(id);
  if (!access.ok) return access.response;

  const parsed = await readBoundedJsonObject(request, MAX_DELETE_BODY_BYTES);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.status === 413 ? 'Request body is too large' : 'Invalid request body' },
      { status: parsed.status }
    );
  }
  const linkId = parsed.value.linkId;
  if (typeof linkId !== 'string' || !LINK_ID_PATTERN.test(linkId)) {
    return NextResponse.json({ error: 'Invalid participant link ID' }, { status: 400 });
  }

  const result = await revokeParticipantLink({
    linkId,
    studyId: access.studyId,
    researcherId: access.researcherId,
    standaloneClient: access.standaloneClient,
  });
  if (result.status === 'not-found') {
    return NextResponse.json({ error: 'Participant link not found' }, { status: 404 });
  }
  if (result.status === 'owner-conflict') {
    return NextResponse.json({ error: 'Participant link ownership does not match this account' }, { status: 403 });
  }
  if (result.status === 'unavailable') {
    return NextResponse.json(
      { error: 'Participant link service is temporarily unavailable', retryable: true },
      { status: 503 }
    );
  }

  return NextResponse.json({
    link: {
      id: linkId,
      revoked: true,
      ...(result.status === 'revoked' ? { revokedAt: result.revokedAt } : {}),
    },
  });
}
