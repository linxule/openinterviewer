import type { ReactNode } from 'react';

/** Replaces outgoing controls until the destination route mounts. */
export default function NavigationStatus({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper-0 px-4 py-12">
      <p role="status" className="font-sans text-[15px] text-ink-500">{children}</p>
    </main>
  );
}
