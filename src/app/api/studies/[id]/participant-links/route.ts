// Researcher-only opaque participant-link management for one canonical study.
// GET returns metadata only; DELETE revokes one hashed link ID atomically.
// Hosted links keep their platform-gated operations; standalone links (Node
// Redis or the Cloudflare durable workspace) go through the workspace store.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { isHostedMode } from '@/lib/mode';
import {
  asStudyAuthorityFromLink,
  listParticipantLinksForStudy,
  revokeParticipantLink,
} from '@/lib/participantLinks';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import {
  getAuthorizedResearcherStudyContext,
  presentStudyAuthority,
  type ResearcherContext,
} from '@/lib/researcherContext';
import { mapStudyLoad } from '@/lib/ownedStudies';
import { researcherHeldCopy, workspaceHeldResponse } from '@/lib/canonicalStudy';
import { logRequestFailure } from '@/lib/requestLog';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';

const STUDY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const LINK_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_DELETE_BODY_BYTES = 4_096;
const MAX_LISTED_LINKS = 1_000;
const ROUTE = '/api/studies/[id]/participant-links';

type StudyLinkAccess =
  | { ok: true; studyId: string; researcherId: string | null; hosted: boolean; context: ResearcherContext }
  | { ok: false; response: NextResponse };

function serviceUnavailable(): NextResponse {
  return NextResponse.json(
    { error: 'Participant link service is temporarily unavailable', retryable: true },
    { status: 503, headers: { 'Cache-Control': 'no-store' } }
  );
}

// Denials and storage failures from either backend use the shared authority
// presenter, exactly as the pre-store route did.
function linkAuthorityDenialResponse(result: { status: string; phase?: 'reserving' | 'pending' | 'resolving' | 'publishing' }): NextResponse | null {
  const authority = asStudyAuthorityFromLink(result);
  if (!authority) return null;
  const presented = presentStudyAuthority(authority, 'researcher');
  if (presented.ok) return null;
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
  const loaded = await gated.context.store.getStudy(studyId);
  const mapped = mapStudyLoad(loaded);
  if (!mapped.ok) {
    return { ok: false, response: NextResponse.json(mapped.body, { status: mapped.status }) };
  }

  const hosted = isHostedMode();
  return {
    ok: true,
    studyId,
    researcherId: hosted ? (gated.researcherId ?? null) : null,
    hosted,
    context: gated.context,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  void request;
  try {
    const { id } = await params;
    const access = await authorizeStudyLinkAccess(id);
    if (!access.ok) return access.response;

    const result = access.hosted
      ? await listParticipantLinksForStudy({
        studyId: access.studyId,
        researcherId: access.researcherId,
        standaloneClient: access.context.kvClient,
        maximum: MAX_LISTED_LINKS,
      })
      : await access.context.store.listParticipantLinks({
        studyId: access.studyId,
        maximum: MAX_LISTED_LINKS,
        now: Date.now(),
      });
    const denied = linkAuthorityDenialResponse(result);
    if (denied) return denied;
    if (result.status !== 'ok') return serviceUnavailable();

    return NextResponse.json(
      { links: result.links, truncated: result.truncated },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    logRequestFailure({ event: 'route.failure', route: ROUTE, method: 'GET', status: 503 }, error);
    return serviceUnavailable();
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const notReady = deploymentNotReadyResponse(ROUTE);
  if (notReady) return notReady;
  try {
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

    const result = access.hosted
      ? await revokeParticipantLink({
        linkId,
        studyId: access.studyId,
        researcherId: access.researcherId,
        standaloneClient: access.context.kvClient,
      })
      : await access.context.store.revokeParticipantLink({
        studyId: access.studyId,
        linkId,
        now: Date.now(),
      });
    const denied = linkAuthorityDenialResponse(result);
    if (denied) return denied;
    if (result.status === 'held') {
      return workspaceHeldResponse({
        route: ROUTE,
        reason: result.reason,
        ...researcherHeldCopy('Participant links cannot be revoked'),
      });
    }
    if (result.status === 'not-found') {
      return NextResponse.json({ error: 'Participant link not found' }, { status: 404 });
    }
    if (result.status === 'owner-conflict') {
      return NextResponse.json({ error: 'Participant link ownership does not match this account' }, { status: 403 });
    }
    if (result.status !== 'revoked' && result.status !== 'already-revoked') return serviceUnavailable();

    return NextResponse.json({
      link: {
        id: linkId,
        revoked: true,
        ...(result.status === 'revoked' ? { revokedAt: result.revokedAt } : {}),
      },
    });
  } catch (error) {
    logRequestFailure({ event: 'route.failure', route: ROUTE, method: 'DELETE', status: 503 }, error);
    return serviceUnavailable();
  }
}
