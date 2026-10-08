'use client';

import { useSyncExternalStore } from 'react';
import { Verbatim } from '@/components/ui';
import { browserMessages } from '@/lib/i18n/useParticipantLanguage';

const subscribeNever = () => () => {};

/**
 * What a participant step (consent, interview, synthesis) shows when this tab
 * holds no study. A participant reaches it when a session kept in memory only
 * (sessionStorage unavailable or full, src/lib/tolerantSessionStorage.ts) is
 * lost to a document load: a reload, or Next.js turning a failed client
 * navigation into one (src/lib/participantLinkHandover.ts). Participant links
 * stay valid until they expire or are revoked, so opening the link again is
 * the recovery.
 *
 * The server and the hydrating client render the store's initial state, which
 * holds no study even when this tab has one, so the notice waits for the
 * client's own state rather than flash on every participant page load.
 */
export default function NoSessionNotice() {
  const onClient = useSyncExternalStore(subscribeNever, () => true, () => false);
  if (!onClient) return <main className="min-h-dvh bg-paper-0" />;
  const m = browserMessages().noSession;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper-0 px-4 py-12">
      <div className="w-full max-w-measure">
        <Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">
          {m.title}
        </Verbatim>
        <p className="mt-4 font-sans text-[15px] text-ink-700">
          {m.body}
        </p>
        <p className="mt-2 font-sans text-[13px] text-ink-500">
          {m.cause}
        </p>
      </div>
    </main>
  );
}
