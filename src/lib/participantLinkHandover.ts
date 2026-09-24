// The participant link page's hand-over to consent (src/app/p/[token]/page.tsx).
// A document navigation, not the client router: the router sends the current
// path, which holds the link code, in its Next-Url request header (RT-10).

export const LEAVE_LINK_PAGE_FOR = '/consent';

export function leaveLinkPage(location: Pick<Location, 'replace'> = window.location): void {
  location.replace(LEAVE_LINK_PAGE_FOR);
}
