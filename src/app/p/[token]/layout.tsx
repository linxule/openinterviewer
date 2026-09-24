import type { Metadata } from 'next';

// The participant link page must not send its URL (which holds the link code)
// as a Referer; next.config.js sets the same policy as a response header.
export const metadata: Metadata = {
  referrer: 'no-referrer',
};

export default function ParticipantLinkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
