// The participant link page's hand-over to consent (src/app/p/[token]/page.tsx).
// A document navigation, not the client router: the router sends the current
// path, which holds the link code, in its Next-Url request header (RT-10).
// A document navigation discards in-memory state, so it is used only when the
// participant session can be read back from sessionStorage; where storage is
// unavailable (the store then runs in memory only), the client router keeps
// the session, at the cost of that one header.
import { RESEARCH_STORE_KEY } from '@/store';

export const LEAVE_LINK_PAGE_FOR = '/consent';

/** Whether a document load will find this participant session in the persisted store. */
export function sessionSurvivesDocumentLoad(
  sessionHandle: string,
  storage: () => Pick<Storage, 'getItem'> = () => window.sessionStorage,
): boolean {
  try {
    const raw = storage().getItem(RESEARCH_STORE_KEY);
    const persisted = raw ? JSON.parse(raw) as { state?: { participantSessionHandle?: unknown } } : null;
    return persisted?.state?.participantSessionHandle === sessionHandle;
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
