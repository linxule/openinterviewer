import { describe, it, expect } from 'vitest';

describe('layout viewport export (K1.8)', () => {
  it('exports width, initialScale, and interactiveWidget', async () => {
    const { viewport } = await import('@/app/layout');
    expect(viewport.width).toBe('device-width');
    expect(viewport.initialScale).toBe(1);
    expect(viewport.interactiveWidget).toBe('resizes-content');
  });

  it('does not set maximumScale or userScalable — pinch-zoom must stay enabled', async () => {
    const { viewport } = await import('@/app/layout');
    expect(viewport.maximumScale).toBeUndefined();
    expect(viewport.userScalable).toBeUndefined();
  });

  it('exports no generateViewport', async () => {
    const layoutModule = await import('@/app/layout');
    expect((layoutModule as Record<string, unknown>).generateViewport).toBeUndefined();
  });
});
