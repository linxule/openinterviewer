export const PREVIEW_HEADER = 'X-OpenInterviewer-Preview';
export const PARTICIPANT_SESSION_HEADER = 'X-OpenInterviewer-Participant-Session';
// Must stay equal to auth.ts PARTICIPANT_SESSION_HANDLE_PATTERN (do not import from auth
// if that pulls server-only jose into a client bundle). Lock with a shared test.
export const PARTICIPANT_SESSION_HANDLE_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export function buildParticipantOrPreviewHeaders(input: {
  researcherPreview?: boolean;
  participantSessionHandle?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (input.researcherPreview === true) {
    headers[PREVIEW_HEADER] = '1';
    return headers;
  }

  const handle = input.participantSessionHandle;
  if (typeof handle === 'string' && PARTICIPANT_SESSION_HANDLE_PATTERN.test(handle)) {
    headers[PARTICIPANT_SESSION_HEADER] = handle;
  }

  return headers;
}
