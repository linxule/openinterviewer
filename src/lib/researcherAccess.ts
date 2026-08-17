import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { isHostedMode } from './mode';
import {
  getRequestContext,
  type RequestContextResult,
  type ResearcherSetupRequirement,
} from './researcherContext';

const DEFAULT_SETUP_REQUIREMENTS: ResearcherSetupRequirement[] = ['onboarding'];

/**
 * Keep hosted accounts without usable BYOS setup out of researcher workspace
 * pages. Middleware remains responsible for unauthenticated requests.
 */
export async function enforceResearcherPageSetup(options?: { onboardingPage?: boolean }) {
  if (!isHostedMode()) return;

  const access = await getRequestContext();
  if (access.setupRequired) {
    if (options?.onboardingPage) return;
    redirect('/onboarding');
  }

  if (options?.onboardingPage && access.authorized && access.context) {
    redirect('/studies');
  }
}

export function schemaHoldResponse(): NextResponse {
  return NextResponse.json({ retryable: false, reason: 'schema-hold' }, { status: 503 });
}

/** Return the standard hosted setup denial before a route falls through to 401. */
export function configurationRequiredResponse(
  access: RequestContextResult
): NextResponse | null {
  if (!access.setupRequired) {
    if (access.statusCode && !access.context) {
      return NextResponse.json(
        {
          error: access.error || 'Researcher service is temporarily unavailable',
          retryable: access.retryable,
          ...(access.code ? { code: access.code } : {}),
          ...(access.reason ? { reason: access.reason } : {}),
        },
        { status: access.statusCode }
      );
    }
    return null;
  }

  return NextResponse.json(
    {
      error: access.error || 'Researcher configuration is required',
      code: 'CONFIGURATION_REQUIRED',
      missing: access.missing?.length ? access.missing : DEFAULT_SETUP_REQUIREMENTS,
    },
    { status: 428 }
  );
}
