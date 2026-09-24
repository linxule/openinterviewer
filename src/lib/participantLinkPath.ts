// Participant link URLs are /p/<code>. next.config.js rewrites them to the
// static /p route, so the client router's state never holds the code
// (src/lib/participantLinkHandover.ts); the link page reads it from the URL.

const LINK_PATH = /^\/p\/([^/]+)$/;

/** The link code in a participant link path, or null when the path is not one. */
export function participantLinkCode(pathname: string): string | null {
  const match = LINK_PATH.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}
