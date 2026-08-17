// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PARTICIPANT_SESSION_HANDLE_PATTERN,
  PARTICIPANT_SESSION_HEADER,
  PREVIEW_HEADER,
  buildParticipantOrPreviewHeaders,
} from '@/services/participantHeaders';

const sessionHandle = 'participant-handle-a-123456';
const repoRoot = resolve(__dirname, '../..');

function patternDeclaration(source: string): string | undefined {
  return source.match(/PARTICIPANT_SESSION_HANDLE_PATTERN = \/\^\[a-zA-Z0-9_-\]\{16,128\}\$\/;/)?.[0];
}

function expectKeys(headers: Record<string, string>, extra: string[] = []) {
  expect(Object.keys(headers).sort()).toEqual(['Content-Type', ...extra].sort());
}

describe('buildParticipantOrPreviewHeaders', () => {
  it('emits only preview authority when researcherPreview is true', () => {
    const headers = buildParticipantOrPreviewHeaders({
      researcherPreview: true,
      participantSessionHandle: sessionHandle,
    });

    expect(headers[PREVIEW_HEADER]).toBe('1');
    expect(headers[PARTICIPANT_SESSION_HEADER]).toBeUndefined();
    expectKeys(headers, [PREVIEW_HEADER]);
  });

  it('emits only a matching participant session handle', () => {
    const headers = buildParticipantOrPreviewHeaders({
      researcherPreview: false,
      participantSessionHandle: sessionHandle,
    });

    expect(headers[PARTICIPANT_SESSION_HEADER]).toBe(sessionHandle);
    expect(headers[PREVIEW_HEADER]).toBeUndefined();
    expectKeys(headers, [PARTICIPANT_SESSION_HEADER]);
  });

  it.each([
    { label: 'missing', handle: undefined },
    { label: 'null', handle: null },
    { label: 'empty', handle: '' },
    { label: 'whitespace', handle: '   ' },
    { label: '15-char', handle: 'a'.repeat(15) },
    { label: '129-char', handle: 'a'.repeat(129) },
    { label: 'space', handle: 'handle with space' },
    { label: 'path', handle: '../not-a-handle' },
  ])('emits no authority for $label handles', ({ handle }) => {
    const headers = buildParticipantOrPreviewHeaders({
      researcherPreview: false,
      participantSessionHandle: handle,
    });

    expect(headers[PREVIEW_HEADER]).toBeUndefined();
    expect(headers[PARTICIPANT_SESSION_HEADER]).toBeUndefined();
    expectKeys(headers);
  });

  it('maps consent preview/participant/neither the same as the shared builder', () => {
    const preview = buildParticipantOrPreviewHeaders({
      researcherPreview: true,
      participantSessionHandle: sessionHandle,
    });
    const participant = buildParticipantOrPreviewHeaders({
      researcherPreview: false,
      participantSessionHandle: sessionHandle,
    });
    const neither = buildParticipantOrPreviewHeaders({
      researcherPreview: false,
      participantSessionHandle: '',
    });

    expect(Object.keys(preview).sort()).toEqual(['Content-Type', PREVIEW_HEADER].sort());
    expect(Object.keys(participant).sort()).toEqual(['Content-Type', PARTICIPANT_SESSION_HEADER].sort());
    expect(Object.keys(neither)).toEqual(['Content-Type']);
    expect(preview[PREVIEW_HEADER]).toBe('1');
    expect(participant[PARTICIPANT_SESSION_HEADER]).toBe(sessionHandle);
  });
});

describe('participant header pattern lock', () => {
  it('matches the auth.ts regex source without importing jose', () => {
    const authSrc = readFileSync(resolve(repoRoot, 'src/lib/auth.ts'), 'utf8');
    const headerSrc = readFileSync(resolve(repoRoot, 'src/services/participantHeaders.ts'), 'utf8');
    const authPattern = patternDeclaration(authSrc);
    const headerPattern = patternDeclaration(headerSrc);

    expect(authPattern).toBeDefined();
    expect(headerPattern).toBe(authPattern);
    expect(PARTICIPANT_SESSION_HANDLE_PATTERN.source).toBe('^[a-zA-Z0-9_-]{16,128}$');
    expect(headerSrc).not.toMatch(/from ['"]@\/lib\/auth['"]/);
  });

  it('selects the shared builder in every named consumer', () => {
    const consumers = [
      'src/services/interviewApi.ts',
      'src/services/storageService.ts',
      'src/components/Consent.tsx',
    ];

    for (const relative of consumers) {
      const source = readFileSync(resolve(repoRoot, relative), 'utf8');
      expect(source).toContain('buildParticipantOrPreviewHeaders');
      expect(source).not.toMatch(/'X-OpenInterviewer-Preview'\s*:/);
      expect(source).not.toMatch(/'X-OpenInterviewer-Participant-Session'\s*:/);
    }
  });
});
