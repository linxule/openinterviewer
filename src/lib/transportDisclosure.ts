// Consent covers the provider transport (gw-final D9, Cloudflare only). The
// participant is shown where responses go; that transport is recorded with
// the consent, copied to the saved interview and frozen into each analysis
// generation. A provider call carrying participant content runs only when
// covers(disclosed, current): the current route is direct, or equals the
// disclosed one. Node deployments bind no transport to consent.

import { NextResponse } from 'next/server';
import type { AIProviderType, StoredInterview } from '@/types';
import { isCloudflareTarget } from './runtime/capabilities';
import {
  covers,
  effectiveTransport,
  type EffectiveTransport,
  type ProviderRoute,
} from './providers/endpoint';
import { isProviderType } from './providers/synthesisModel';
import { isSampleFixtureInterview } from './sampleFixtures';

export type CurrentTransport =
  /** Node: consent binds no transport. */
  | { applies: false }
  /** Cloudflare: the transport a request for this provider uses now. */
  | { applies: true; ok: true; transport: EffectiveTransport }
  /** Cloudflare with an invalid route: fail closed, never assume direct. */
  | { applies: true; ok: false };

/** Cloudflare only: the transport the provider would use on this request's route. */
export function currentProviderTransport(
  context: { providerRoute?: ProviderRoute | null },
  provider: unknown,
): CurrentTransport {
  if (!isCloudflareTarget()) return { applies: false };
  const route = context.providerRoute;
  if (!route) return { applies: true, ok: false };
  const transport = isProviderType(provider)
    ? effectiveTransport(route, provider as AIProviderType)
    : route.transport;
  return { applies: true, ok: true, transport };
}

/** The stored optional member for a transport: present only for the gateway. */
export function disclosedMember(
  transport: EffectiveTransport,
): { disclosedTransport?: 'cloudflare-gateway' } {
  return transport === 'cloudflare-gateway' ? { disclosedTransport: 'cloudflare-gateway' } : {};
}

/**
 * The consent disclosures a researcher call over these interviews must cover.
 * Sample fixtures are synthetic, have no participant and carry no disclosure,
 * so they need none; every other interview counts, absent meaning direct.
 */
export function participantDisclosures(
  interviews: ReadonlyArray<Pick<StoredInterview, 'id' | 'studyId' | 'consentTransport'>>,
): Array<'cloudflare-gateway' | undefined> {
  return interviews
    .filter((interview) => !isSampleFixtureInterview(interview))
    .map((interview) => interview.consentTransport);
}

/** Whether every record's disclosure covers `current`; absent means direct. */
export function uncoveredCount(
  disclosures: ReadonlyArray<'cloudflare-gateway' | undefined>,
  current: EffectiveTransport,
): number {
  return disclosures.filter((disclosed) => !covers(disclosed ?? 'direct', current)).length;
}

export function providerNotConfiguredResponse(): NextResponse {
  return NextResponse.json({ error: 'AI provider is not configured on the server.' }, { status: 502 });
}

/** A participant request whose consent does not cover the current transport. */
export function transportNotDisclosedResponse(): NextResponse {
  return NextResponse.json(
    {
      code: 'TRANSPORT_NOT_DISCLOSED',
      error: 'This study now sends responses by a different route than the one you agreed to. Reopen the study link to review the updated notice.',
    },
    { status: 409 },
  );
}

/** Researcher routes: the interviews that were consented under another transport. */
export function researcherTransportNotDisclosedResponse(count: number, extra?: HeadersInit): NextResponse {
  return NextResponse.json(
    {
      code: 'TRANSPORT_NOT_DISCLOSED',
      error: `${count} interview${count === 1 ? ' was' : 's were'} consented under a different AI transport than this installation now uses, so ${count === 1 ? 'it' : 'they'} cannot be sent to the provider. The operator can switch the installation back to direct transport to analyze ${count === 1 ? 'it' : 'them'}.`,
      uncoveredInterviewCount: count,
    },
    { status: 409, ...(extra ? { headers: extra } : {}) },
  );
}
