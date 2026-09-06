// @vitest-environment node

// Offline regression for the live smoke's failure boundary: whatever an
// adapter throws, nothing from its response can reach the runner's output.
// The sanitized error is what Vitest prints, so every surface a reporter
// reads (message, name, stack, own properties, cause, JSON, inspect) is
// checked for the planted markers.

import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ProviderFailure, ProviderTimeoutError } from '@/lib/providerErrors';
import { classifySmokeFailure, sanitizedSmokeError } from '../smoke/smokeFailure';

const BODY_MARKER = 'RESPONSE_BODY_MARKER_9f1c';
const HEADER_MARKER = 'Bearer sk-HEADER_MARKER_2b7e';
const OUTPUT_MARKER = 'MODEL_OUTPUT_MARKER_44aa';

function sdkLikeCause() {
  const cause = new Error(`400 ${BODY_MARKER}`) as Error & Record<string, unknown>;
  cause.status = 400;
  cause.headers = { authorization: HEADER_MARKER };
  cause.response = { body: `{"error":"${BODY_MARKER}"}`, text: BODY_MARKER };
  cause.error = { message: BODY_MARKER, output: OUTPUT_MARKER };
  return cause;
}

function everySurface(error: Error): string {
  return [
    error.message,
    error.name,
    error.stack ?? '',
    JSON.stringify(error),
    JSON.stringify(Object.getOwnPropertyNames(error).map(key => (error as unknown as Record<string, unknown>)[key])),
    inspect(error, { depth: 10, showHidden: true }),
    String((error as { cause?: unknown }).cause),
  ].join('\n');
}

describe('smokeFailure: classification reads no error content', () => {
  it('maps a ProviderFailure to its kind and everything else to a class', () => {
    expect(classifySmokeFailure(new ProviderFailure('invalid-response', BODY_MARKER, sdkLikeCause())))
      .toEqual({ class: 'ProviderFailure', kind: 'invalid-response' });
    expect(classifySmokeFailure(new ProviderTimeoutError(1))).toEqual({ class: 'ProviderTimeoutError' });
    const validation = new Error(OUTPUT_MARKER);
    validation.name = 'ValidationError';
    expect(classifySmokeFailure(validation)).toEqual({ class: 'ValidationError' });
    expect(classifySmokeFailure({ response: BODY_MARKER })).toEqual({ class: 'UnknownError' });
    expect(classifySmokeFailure(BODY_MARKER)).toEqual({ class: 'UnknownError' });
  });

  it('falls back to unavailable for a kind outside the allowlist', () => {
    const failure = new ProviderFailure('unavailable', 'x');
    (failure as { kind: string }).kind = BODY_MARKER;
    expect(classifySmokeFailure(failure)).toEqual({ class: 'ProviderFailure', kind: 'unavailable' });
  });
});

describe('smokeFailure: the thrown error carries nothing from the original', () => {
  const originals: unknown[] = [
    new ProviderFailure('invalid-response', `gemini synthesis ${BODY_MARKER}`, sdkLikeCause()),
    new ProviderFailure('unavailable', OUTPUT_MARKER, { response: { body: BODY_MARKER } }),
    new ProviderTimeoutError(5, BODY_MARKER),
    Object.assign(new Error(BODY_MARKER), { name: 'ValidationError', output: OUTPUT_MARKER }),
    Object.assign(new Error(BODY_MARKER), { cause: sdkLikeCause(), response: sdkLikeCause() }),
    sdkLikeCause(),
    { message: BODY_MARKER, response: { body: BODY_MARKER } },
    BODY_MARKER,
  ];

  it.each(originals.map((original, index) => [index, original] as const))(
    'original %i: no response-body, header, or output marker on any reporter-visible surface',
    (_index, original) => {
      const sanitized = sanitizedSmokeError(classifySmokeFailure(original));
      const surface = everySurface(sanitized);
      expect(surface).not.toContain(BODY_MARKER);
      expect(surface).not.toContain(HEADER_MARKER);
      expect(surface).not.toContain(OUTPUT_MARKER);
      expect((sanitized as { cause?: unknown }).cause).toBeUndefined();
      expect(Object.getOwnPropertyNames(sanitized).sort()).toEqual(['message', 'name', 'stack']);
      expect(sanitized).not.toBe(original);
    },
  );

  it('names the class and kind so the finding is still readable', () => {
    expect(sanitizedSmokeError({ class: 'ProviderFailure', kind: 'invalid-response' }).message)
      .toBe('live provider smoke failed: ProviderFailure/invalid-response');
    expect(sanitizedSmokeError({ class: 'ProviderTimeoutError' }).message)
      .toBe('live provider smoke failed: ProviderTimeoutError');
  });
});
