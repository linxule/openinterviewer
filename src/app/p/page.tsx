'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { StudyConfig } from '@/types';
import { Verbatim } from '@/components/ui';
import type { AITransport } from '@/lib/aiTransport';
import { leaveLinkPage } from '@/lib/participantLinkHandover';
import { participantLinkCode } from '@/lib/participantLinkPath';

/** The exchange's transport; anything but the three known values (including none) is null. */
function participantTransport(value: unknown): AITransport | null {
  return value === 'direct' || value === 'gateway' || value === 'cloudflare-gateway' ? value : null;
}

/**
 * Resolves a participant link and hands over to `/consent`. It never renders
 * an interview step itself: a step shown here while the route change is still
 * in flight would be replaced by the destination page's own copy, discarding
 * whatever the participant had typed and repeating its mount-time requests.
 *
 * The link code must not leave this page in a request header (RT-10: request
 * headers reach live Worker logs, where only the URL is redacted). The
 * document is served with `Referrer-Policy: no-referrer` (next.config.js,
 * ./layout.tsx), the exchange fetch sets it again, and this route is reached
 * by a rewrite of /p/<code> (next.config.js), so the client router's state (sent
 * in its `Next-Url` and `Next-Router-State-Tree` headers) holds no code. The
 * code is read from the address bar instead of route parameters. The
 * hand-over is a document navigation where the session survives one in
 * sessionStorage (src/store.ts), and the client router otherwise
 * (src/lib/participantLinkHandover.ts).
 */
export default function ParticipantPage() {
  const router = useRouter();

  const beginParticipantSession = useStore((state) => state.beginParticipantSession);

  const [error, setError] = useState<string | null>(null);

  // Resolve the opaque link code and establish a cookie-backed participant session.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    const linkCode = participantLinkCode(window.location.pathname);
    const loadStudyFromLink = async () => {
      if (!linkCode) {
        setError('No participant link code provided');
        return;
      }

      try {
        const response = await fetch(`/api/generate-link?token=${encodeURIComponent(linkCode)}`, {
          referrerPolicy: 'no-referrer',
        });
        const result = await response.json();
        if (cancelled) return;

        if (!result.valid || !result.data) {
          setError('Invalid or expired link');
          return;
        }

        const resolvedLink = result.data as {
          studyConfig: StudyConfig;
          sessionHandle?: string;
          aiTransport?: unknown;
        };
        if (!resolvedLink.sessionHandle) {
          setError('The participant session could not be established');
          return;
        }
        // The consent page discloses this transport, so an unknown value is a
        // load error rather than a guess.
        const aiTransport = participantTransport(resolvedLink.aiTransport);
        if (!aiTransport) {
          setError('This study could not confirm how your responses are sent');
          return;
        }
        beginParticipantSession(
          resolvedLink.studyConfig,
          resolvedLink.sessionHandle,
          aiTransport,
        );
        // Stay on the loading view until /consent replaces this document.
        leaveLinkPage(resolvedLink.sessionHandle, (href) => router.replace(href));
      } catch (err) {
        if (cancelled) return;
        console.error('Error loading study from participant link:', err);
        setError('Failed to load study configuration');
      }
    };

    loadStudyFromLink();
    return () => { cancelled = true; };
  }, [beginParticipantSession, router]);

  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-paper-0 px-4 py-12">
        <div className="w-full max-w-measure">
          <Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">
            Unable to Load Interview
          </Verbatim>
          <p className="mt-4 font-sans text-[15px] text-ink-700">{error}</p>
          <p className="mt-2 font-sans text-[13px] text-ink-500">
            Please check that you have the correct link or contact the researcher.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper-0 px-4 py-12">
      <div className="w-full max-w-measure">
        <p role="status" className="font-sans text-[15px] text-ink-500">Loading interview...</p>
      </div>
    </main>
  );
}
