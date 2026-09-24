// The participant link page's hand-over to consent (src/app/p/page.tsx).
//
// The preferred hand-over is a document navigation: the new page reads the
// session back from sessionStorage and makes no request from the link page's
// router state. A document navigation discards in-memory state, so it is used
// only when the participant session can be read back in full. Where it cannot
// (storage unavailable or full, src/lib/tolerantSessionStorage.ts: the store
// then runs in memory only) the client router keeps the session.
//
// The client router sends its current path in the Next-Url header and its
// route tree, dynamic parameter values included, in Next-Router-State-Tree
// (next/dist/client/components/router-reducer/fetch-server-response.js). Link
// URLs are therefore rewritten to the static /p route (next.config.js), whose
// router state holds no link code, so neither header carries it (RT-10).
//
// A memory-only session is still lost to any document load: a reload, or
// Next.js turning a client navigation into a document navigation when the
// Flight response fails, is not Flight, or comes from another build
// (fetch-server-response.js, doMpaNavigation). The participant steps then show
// how to recover (src/components/NoSessionNotice.tsx): the link is reusable
// until it expires or is revoked, and opening it again starts a new session.
import { RESEARCH_STORE_KEY, RESEARCH_STORE_VERSION } from '@/store';

export const LEAVE_LINK_PAGE_FOR = '/consent';

const KNOWN_TRANSPORTS: ReadonlySet<unknown> = new Set(['direct', 'gateway', 'cloudflare-gateway']);

/**
 * Whether a document load will find this participant session in the persisted
 * store: this handle, a study, a known transport (the consent page discloses
 * it) and the current store version (another version is migrated on load, so
 * this check could not vouch for what the new page reads).
 */
export function sessionSurvivesDocumentLoad(
  sessionHandle: string,
  storage: () => Pick<Storage, 'getItem'> = () => window.sessionStorage,
): boolean {
  try {
    const raw = storage().getItem(RESEARCH_STORE_KEY);
    const persisted = raw ? JSON.parse(raw) as {
      version?: unknown;
      state?: { participantSessionHandle?: unknown; studyConfig?: unknown; aiTransport?: unknown };
    } | null : null;
    const state = persisted?.state;
    const studyConfig = state?.studyConfig as { id?: unknown } | null | undefined;
    return persisted?.version === RESEARCH_STORE_VERSION
      && state?.participantSessionHandle === sessionHandle
      && typeof studyConfig === 'object' && studyConfig !== null && typeof studyConfig.id === 'string'
      && KNOWN_TRANSPORTS.has(state.aiTransport);
  } catch {
    return false;
  }
}

export function leaveLinkPage(
  sessionHandle: string,
  clientNavigate: (href: string) => void,
  location: Pick<Location, 'replace'> = window.location,
  storage?: () => Pick<Storage, 'getItem'>,
): void {
  if (sessionSurvivesDocumentLoad(sessionHandle, storage)) location.replace(LEAVE_LINK_PAGE_FOR);
  else clientNavigate(LEAVE_LINK_PAGE_FOR);
}
