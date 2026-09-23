// Request-level readiness gate for the Cloudflare target (SETUP-03, gap
// review F10). A not-ready installation keeps participant and researcher
// mutations and provider calls closed: mutating and provider routes call this
// before touching storage or a provider. Node deployments are unaffected (their
// readiness contract is unchanged). The WorkspaceStore object independently
// repeats identity, epoch and maintenance checks at every write.

import { NextResponse } from 'next/server';
import { getPublicConfig } from '../hostedConfig';
import { logRequestEvent } from '../requestLog';
import { isCloudflareTarget } from './capabilities';

export function deploymentNotReadyResponse(route: string): NextResponse | null {
  if (!isCloudflareTarget()) return null;
  const config = getPublicConfig();
  if (config.ready) return null;
  logRequestEvent({ event: 'route.failure', route, status: 503, reason: 'not-configured' });
  return NextResponse.json(
    {
      error: 'This deployment is not ready. Its operator must complete the configuration first.',
      code: 'DEPLOYMENT_NOT_READY',
      retryable: false,
    },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
