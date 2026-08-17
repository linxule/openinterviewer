// Researcher-only opaque participant-link management for one canonical study.
// GET returns metadata only; DELETE revokes one hashed link ID atomically.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { RedisPort } from '../../../../../lib/redisPort';
import { getStudyChecked } from '@/lib/kv';
import { isHostedMode } from '@/lib/mode';
import {
  asStudyAuthorityFromLink,
  listParticipantLinksForStudy,
  revokeParticipantLink,
} from '@/lib/participantLinks';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { getAuthorizedResearcherStudyContext, presentStudyAuthority } from '@/lib/researcherContext';
import { mapStudyLoad } from '@/lib/ownedStudies';

const STUDY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const LINK_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_DELETE_BODY_BYTES = 4_096;

type StudyLinkAccess =
  | { ok: true; studyId: string; researcherId: string | null; standaloneClient: RedisPort }
  | { ok: false; response: NextResponse };

async function authorizeStudyLinkAccess(studyId: string): Promise<StudyLinkAccess> {
  if (!STUDY_ID_PATTERN.test(studyId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid study ID' }, { status: 400 }),
    };
  }

  const gated = await getAuthorizedResearcherStudyContext(studyId, 'link');
  const denied = configurationRequiredResponse(gated);
  if (denied) return { ok: false, response: denied };
  if (!gated.authorized || !gated.context) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: gated.error || 'Unauthorized',
          retryable: gated.retryable,
          ...(gated.code ? { code: gated.code } : {}),
          ...(gated.reason ? { reason: gated.reason } : {}),
        },
        { status: gated.statusCode ?? 401 },
      ),
    };
  }

  // Both modes require a real canonical BYOS/standalone study record. A link
  // index alone is never authority to inspect or mutate a study's links.
  const loaded = await getStudyChecked(studyId, gated.context.kvClient);
  const mapped = mapStudyLoad(loaded);
  if (!mapped.ok) {
    return { ok: false, response: NextResponse.json(mapped.body, { status: mapped.status }) };
  }

  return {
    ok: true,
    studyId,
    researcherId: isHostedMode() ? (gated.researcherId ?? null) : null,
    standaloneClient: gated.context.kvClient,
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
  const listAuthority = asStudyAuthorityFromLink(result);
  if (listAuthority) {
    const presented = presentStudyAuthority(listAuthority, 'researcher');
    if (!presented.ok) {
      return NextResponse.json(
        {
          error: presented.error,
          retryable: presented.retryable,
          ...(presented.code ? { code: presented.code } : {}),
          ...(presented.reason ? { reason: presented.reason } : {}),
        },
        { status: presented.statusCode },
      );
    }
  }
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
  const revokeAuthority = asStudyAuthorityFromLink(result);
  if (revokeAuthority) {
    const presented = presentStudyAuthority(revokeAuthority, 'researcher');
    if (!presented.ok) {
      return NextResponse.json(
        {
          error: presented.error,
          retryable: presented.retryable,
          ...(presented.code ? { code: presented.code } : {}),
          ...(presented.reason ? { reason: presented.reason } : {}),
        },
        { status: presented.statusCode },
      );
    }
  }
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
