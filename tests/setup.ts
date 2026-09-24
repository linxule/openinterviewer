import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// next/font/local calls are substituted by Next's build pipeline; under vitest
// (no SWC font transform) the raw module isn't callable. src/fonts/latin.ts
// only needs the call to return the shape Next's loader returns.
vi.mock('next/font/local', () => ({
  default: () => ({
    className: 'mock-next-font',
    style: { fontFamily: 'mock-next-font' },
  }),
}));

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
