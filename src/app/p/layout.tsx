import type { Metadata } from 'next';

// Every participant link, /p/<code>, is rendered here (next.config.js rewrites
// it). Its URL holds the link code: it must not be sent as a Referer
// (next.config.js sets the same policy as a response header), and the page is
// rendered per request, as the dynamic link route it replaces was.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  referrer: 'no-referrer',
};

export default function ParticipantLinkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
