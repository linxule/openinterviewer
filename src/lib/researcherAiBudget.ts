import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from './auth';
import { RESEARCHER_WORKSPACE_HELD_COPY, workspaceHeldResponse } from './canonicalStudy';
import { isHostedMode } from './mode';
import { logRequestEvent } from './requestLog';
import {
  RESEARCHER_AI_KEY_PREFIX,
  type AdmissionOutcome,
  type ResearcherAiCounter,
  type ResearcherAiOperation,
  type WorkspaceStorePort,
} from './storage/types';

type Window = { maximum: number; windowSeconds: number };

/**
 * Researcher AI budget on the standalone targets (Node and Cloudflare; D15).
 * Hosted mode keeps HOSTED_AI_RATE_LIMIT_POLICY and never charges this one.
 *
 * `session` is one signed-in researcher session; `researcher` is the
 * installation's workspace (standalone has one researcher account). There is
 * no `network` scope: every call already needs the administrator session.
 *
 * Numbers follow HOSTED_AI_RATE_LIMIT_POLICY where the operation means the
 * same thing: aggregate, follow-up and analysis are researcher-only there too,
 * and 60 preview turns an hour is a participant's pace. Where hosted numbers
 * were sized for participants they are changed: a preview greeting restarts
 * whenever the researcher edits and re-previews (hosted: 3 per 10 minutes for
 * one participant session), and preview synthesis is a repeatable preview
 * (hosted: 2 a day, one participant save). The hosted `researcher` ceilings
 * for greeting, interview and synthesis also count every participant of the
 * researcher; here only the researcher's own calls count, so they are lower.
 */
export const STANDALONE_RESEARCHER_AI_POLICY: Record<ResearcherAiOperation, { session: Window; researcher: Window }> = {
  greeting: {
    session: { maximum: 10, windowSeconds: 600 },
    researcher: { maximum: 200, windowSeconds: 86_400 },
  },
  interview: {
    session: { maximum: 60, windowSeconds: 3_600 },
    researcher: { maximum: 1_000, windowSeconds: 86_400 },
  },
  synthesis: {
    session: { maximum: 10, windowSeconds: 3_600 },
    researcher: { maximum: 100, windowSeconds: 86_400 },
  },
  aggregate: {
    session: { maximum: 20, windowSeconds: 3_600 },
    researcher: { maximum: 100, windowSeconds: 86_400 },
  },
  followup: {
    session: { maximum: 20, windowSeconds: 3_600 },
    researcher: { maximum: 100, windowSeconds: 86_400 },
  },
  analysis: {
    session: { maximum: 100, windowSeconds: 3_600 },
    researcher: { maximum: 500, windowSeconds: 86_400 },
  },
};

const LIMITED_MESSAGE = 'Too many AI requests from this workspace. Please wait before trying again.';
const UNAVAILABLE_MESSAGE = 'Unable to verify AI request limits. Please try again later.';

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const pair of header.split(';')) {
    const [key, ...parts] = pair.trim().split('=');
    if (key === name) return parts.join('=') || null;
  }
  return null;
}

/**
 * The researcher budget counters for this request, in policy order, or null
 * when the request carries no verified standalone researcher session. The
 * session subject is a digest of the verified session token (the standalone
 * token has no id claim), so a raw token never reaches a key.
 */
export async function researcherAiCounters(
  request: Request,
  operation: ResearcherAiOperation,
): Promise<ResearcherAiCounter[] | null> {
  const token = cookieValue(request, SESSION_COOKIE_NAME);
  if (!token || token.length > 8_192) return null;
  const session = await verifySessionToken(token);
  if (!session.valid || session.researcherId !== undefined) return null;
  const sessionSubject = createHash('sha256').update(`researcher-session\u0000${token}`).digest('hex');
  const policy = STANDALONE_RESEARCHER_AI_POLICY[operation];
  return [
    {
      key: `${RESEARCHER_AI_KEY_PREFIX}${operation}:session:${policy.session.windowSeconds}:${sessionSubject}`,
      ...policy.session,
    },
    {
      key: `${RESEARCHER_AI_KEY_PREFIX}${operation}:researcher:${policy.researcher.windowSeconds}:workspace`,
      ...policy.researcher,
    },
  ];
}

export function researcherAiLimitedResponse(retryAfterSeconds: number): NextResponse {
  const seconds = Number.isFinite(retryAfterSeconds) ? Math.max(1, Math.ceil(retryAfterSeconds)) : 60;
  return NextResponse.json(
    { error: LIMITED_MESSAGE, retryable: true },
    { status: 429, headers: { 'Retry-After': String(seconds), 'Cache-Control': 'no-store' } },
  );
}

export function researcherAiUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: UNAVAILABLE_MESSAGE, retryable: true },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** Logged and answered when a researcher route reaches the budget without a verified session. */
export function researcherAiIdentityResponse(route: string, operation: ResearcherAiOperation): NextResponse {
  logRequestEvent({ event: 'admission.identity', route, reason: 'identity-missing', operation: `researcher-ai-${operation}` });
  return researcherAiUnavailableResponse();
}

function outcomeResponse(outcome: AdmissionOutcome, route: string): NextResponse | null {
  switch (outcome.status) {
    case 'admitted':
      return null;
    case 'limited':
      return researcherAiLimitedResponse(outcome.retryAfterSeconds);
    case 'held':
      return workspaceHeldResponse({ route, reason: outcome.reason, ...RESEARCHER_WORKSPACE_HELD_COPY });
    default:
      return researcherAiUnavailableResponse();
  }
}

/**
 * Charge the researcher AI budget before a researcher-initiated provider call
 * on a standalone target: null to proceed, else 429 (Retry-After), a held
 * workspace 503, or 503 fail-closed when the session or the budget store
 * cannot be established. Always null in hosted mode.
 */
export async function researcherAiBudgetResponse(
  request: Request,
  operation: ResearcherAiOperation,
  store: Pick<WorkspaceStorePort, 'admitResearcherAiRequest'>,
  route: string,
): Promise<NextResponse | null> {
  if (isHostedMode()) return null;
  const counters = await researcherAiCounters(request, operation);
  if (!counters) return researcherAiIdentityResponse(route, operation);
  let outcome: AdmissionOutcome;
  try {
    outcome = await store.admitResearcherAiRequest({ operation, counters, now: Date.now() });
  } catch {
    outcome = { status: 'unavailable' };
  }
  return outcomeResponse(outcome, route);
}
