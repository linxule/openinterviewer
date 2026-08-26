import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// next/font/google loaders are substituted by Next's build pipeline; under
// vitest (no SWC font transform) the raw module isn't callable. Each Google
// font used by src/app/layout.tsx resolves to a stub with the shape callers rely on.
vi.mock('next/font/google', () => {
  const loader = (options: { variable?: string } = {}) => ({
    className: 'mock-next-font',
    variable: options.variable ?? '--font-mock',
    style: { fontFamily: 'mock-next-font' },
  });
  return {
    Source_Serif_4: loader,
    Public_Sans: loader,
    IBM_Plex_Mono: loader,
  };
});

afterEach(() => {
  cleanup();
});

// jsdom shims required by framer-motion / RTL / browser-only APIs
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  window.scrollTo = vi.fn();
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
