'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Coordinate } from '@/components/ui';

interface BreadcrumbContextValue {
  trailing: string | null;
  setTrailing: (label: string | null) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [trailing, setTrailing] = useState<string | null>(null);
  const value = useMemo(() => ({ trailing, setTrailing }), [trailing]);
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>;
}

function useBreadcrumbContext(): BreadcrumbContextValue {
  const ctx = useContext(BreadcrumbContext);
  if (!ctx) {
    throw new Error('useSetTrailingCrumb must be used within a BreadcrumbProvider');
  }
  return ctx;
}

export function useSetTrailingCrumb(label: string | null) {
  const { setTrailing } = useBreadcrumbContext();
  useEffect(() => {
    setTrailing(label);
    return () => setTrailing(null);
    // Re-run whenever the caller's label changes; setTrailing is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);
}

interface CrumbItem {
  label: string;
  href: string | null;
  mono?: boolean;
}

function buildTrail(pathname: string, trailing: string | null): CrumbItem[] {
  if (pathname === '/settings') {
    return [{ label: 'Settings', href: null }];
  }

  if (pathname === '/studies') {
    return [{ label: 'Studies', href: null }];
  }

  const studyDetailMatch = pathname.match(/^\/studies\/([^/]+)$/);
  if (studyDetailMatch) {
    const id = studyDetailMatch[1];
    return [
      { label: 'Studies', href: '/studies' },
      { label: trailing ?? id.slice(0, 8), href: null, mono: !trailing },
    ];
  }

  if (pathname === '/setup') {
    return [
      { label: 'Studies', href: '/studies' },
      { label: 'New study', href: null },
    ];
  }

  if (pathname === '/dashboard') {
    const items: CrumbItem[] = [
      { label: 'Studies', href: '/studies' },
      { label: 'Interviews', href: trailing ? '/dashboard' : null },
    ];
    if (trailing) items.push({ label: trailing, href: null });
    return items;
  }

  const interviewDetailMatch = pathname.match(/^\/dashboard\/interview\/([^/]+)$/);
  if (interviewDetailMatch) {
    const id = interviewDetailMatch[1];
    return [
      { label: 'Studies', href: '/studies' },
      { label: 'Interviews', href: '/dashboard' },
      { label: trailing ?? id.slice(0, 8), href: null, mono: !trailing },
    ];
  }

  return [{ label: 'Studies', href: '/studies' }];
}

export function Breadcrumb() {
  const pathname = usePathname();
  const { trailing } = useBreadcrumbContext();
  const items = buildTrail(pathname, trailing);

  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-2 text-[13px] text-ink-500">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          const content = item.mono ? <Coordinate>{item.label}</Coordinate> : item.label;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-2">
              {index > 0 && (
                <span aria-hidden="true" className="text-ink-300">
                  /
                </span>
              )}
              {isLast ? (
                <span aria-current="page" className="text-ink-900">
                  {content}
                </span>
              ) : item.href ? (
                <Link href={item.href} className="underline-offset-2 hover:text-ink-900 hover:underline">
                  {content}
                </Link>
              ) : (
                <span>{content}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
