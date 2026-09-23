// HTTP mapping for provider failures (route-only; imports next/server).
// Kept apart from providerErrors.ts so non-HTTP callers, such as the
// Cloudflare Queue consumer, never bundle Next.

import { NextResponse } from 'next/server';
import { ProviderFailure, ProviderTimeoutError } from './providerErrors';
import { logRequestFailure, wasErrorLogged } from './requestLog';

// Map a provider failure to a safe, honest JSON error response.
// Messages are generic on purpose: they never echo provider details.
export function providerErrorResponse(err: unknown): NextResponse {
  if (err instanceof ProviderTimeoutError) {
    return NextResponse.json(
      { error: 'The AI provider took too long to respond. Please try again.', retryable: true },
      { status: 504 }
    );
  }
  if (err instanceof ProviderFailure) {
    switch (err.kind) {
      case 'config':
        return NextResponse.json(
          {
            error: 'The AI provider rejected the request. Please check the provider configuration and try again.',
            retryable: false,
          },
          { status: 502 }
        );
      case 'rate-limited':
        return NextResponse.json(
          { error: 'The AI provider is receiving too many requests right now. Please try again shortly.', retryable: true },
          { status: 503 }
        );
      case 'invalid-response':
        return NextResponse.json(
          { error: 'The AI provider returned an invalid response. Please try again.', retryable: true },
          { status: 502 }
        );
      case 'unavailable':
        return NextResponse.json(
          { error: 'The AI provider is temporarily unavailable. Please try again.', retryable: true },
          { status: 502 }
        );
    }
  }
  if (!wasErrorLogged(err)) {
    logRequestFailure({
      event: 'route.failure',
      route: 'provider',
      errorType: err instanceof Error ? err.name : 'UnknownError',
    }, err);
  }
  return NextResponse.json({ error: 'Failed to generate response' }, { status: 500 });
}
