'use client';

import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, Coordinate, Label, Page } from '@/components/ui';
import { BreadcrumbProvider, Breadcrumb } from './breadcrumb';

const destinations = [
  { label: 'Studies', href: '/studies' },
  { label: 'Interviews', href: '/dashboard' },
  { label: 'Settings', href: '/settings' },
];

function isDestinationActive(href: string, pathname: string): boolean {
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/');
  const inInterviews = pathname === '/dashboard' || pathname.startsWith('/dashboard/');
  if (href === '/settings') return inSettings;
  if (href === '/dashboard') return inInterviews;
  // '/studies' is the fallback destination: it owns /studies, /studies/<id>, and /setup.
  return !inSettings && !inInterviews;
}

export default function ResearcherShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const handleLogout = async () => {
    try {
      await fetch('/api/auth', { method: 'DELETE' });
      router.push('/login');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  return (
    <BreadcrumbProvider>
      <a
        href="#researcher-main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-paper-1 focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <nav
        aria-label="Researcher"
        className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-60 lg:flex-col border-r border-ink-300 bg-paper-1 px-5 py-6"
      >
        <Link href="/studies" className="font-sans text-[15px] font-semibold text-ink-900">
          OpenInterviewer
        </Link>
        <div className="mt-8 flex flex-col gap-0.5">
          {destinations.map((destination) => {
            const active = isDestinationActive(destination.href, pathname);
            return (
              <Link
                key={destination.href}
                href={destination.href}
                aria-current={active ? 'page' : undefined}
                className={`border-l-2 py-1.5 pl-3 font-sans text-[14px] ${
                  active
                    ? 'border-action font-semibold text-action'
                    : 'border-transparent text-ink-700 hover:text-ink-900'
                }`}
              >
                {destination.label}
              </Link>
            );
          })}
        </div>
        <div className="mt-auto">
          <Label>Account</Label>
          <Button
            type="button"
            variant="quiet"
            onClick={() => void handleLogout()}
            className="mt-2 w-full text-[13px]"
          >
            Log out
          </Button>
        </div>
        <Coordinate className="mt-4 block">Your keys · your database</Coordinate>
      </nav>

      <nav
        aria-label="Researcher"
        className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b border-ink-300 bg-paper-0 px-4 lg:hidden"
      >
        <Link href="/studies" className="font-sans text-[15px] font-semibold text-ink-900">
          OpenInterviewer
        </Link>
        {destinations.map((destination) => {
          const active = isDestinationActive(destination.href, pathname);
          return (
            <Link
              key={destination.href}
              href={destination.href}
              aria-current={active ? 'page' : undefined}
              className={`text-[13px] ${active ? 'font-semibold text-action' : 'text-ink-700 hover:text-ink-900'}`}
            >
              {destination.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => void handleLogout()}
          className="ml-auto shrink-0 whitespace-nowrap text-[13px] text-ink-500 hover:text-ink-900"
        >
          Log out
        </button>
      </nav>

      <main id="researcher-main" className="min-h-dvh bg-paper-0 lg:pl-60">
        <Page className="py-6 lg:py-10">
          <Breadcrumb />
          {children}
        </Page>
        <Coordinate className="mt-12 block px-5 pb-6 lg:hidden">Your keys · your database</Coordinate>
      </main>
    </BreadcrumbProvider>
  );
}
