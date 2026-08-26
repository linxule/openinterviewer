import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';

/**
 * Slice E regressions: StudySetup reskins as a faithful document — every
 * section stays mounted, the section index only scrolls (never switches),
 * icons are gone, and register rows (profile fields / questions) never take
 * reading measure.
 */

const storeMock = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  seed: (initial: Record<string, unknown>) => {
    storeMock.state = { ...initial };
  },
}));

vi.mock('@/store', () => ({
  useStore: Object.assign(
    () => storeMock.state,
    { getState: () => storeMock.state }
  ),
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
}));

import StudySetup from '@/components/StudySetup';

const SECTION_IDS = [
  'study-details',
  'profile-fields',
  'core-questions',
  'topic-areas',
  'ai-provider',
  'ai-interview-style',
  'link-settings',
  'consent-text',
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/api/auth') {
      return { ok: true, status: 200, json: async () => ({ authenticated: false }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  }));

  storeMock.seed({
    studyConfig: null,
    setStudyConfig: vi.fn(),
    setStep: vi.fn(),
    loadExampleStudy: vi.fn(),
    setViewMode: vi.fn(),
    setAiTransport: vi.fn(),
    resetParticipant: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StudySetup document reskin', () => {
  it('renders a non-switching section index whose links resolve to sections that are all mounted at once', () => {
    const { container } = render(<StudySetup />);

    const nav = screen.getByRole('navigation', { name: 'Study sections' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(SECTION_IDS.length);

    for (const id of SECTION_IDS) {
      const link = links.find((candidate) => candidate.getAttribute('href') === `#${id}`);
      expect(link, `expected a link to #${id}`).toBeTruthy();
      expect(container.querySelector(`#${id}`)).toBeInTheDocument();
    }
  });

  it('carries no decorative icons', () => {
    const { container } = render(<StudySetup />);
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('never applies reading measure to profile-field or question register rows', () => {
    render(<StudySetup />);

    fireEvent.click(screen.getByRole('button', { name: /Current Role/ }));
    const fieldRow = screen.getByPlaceholderText('Field label (e.g., Current Role)');
    let node: HTMLElement | null = fieldRow;
    while (node && node !== document.body) {
      expect(node.className).not.toMatch(/max-w-measure/);
      node = node.parentElement;
    }

    const questionRow = screen.getByPlaceholderText('Question 1...');
    node = questionRow;
    while (node && node !== document.body) {
      expect(node.className).not.toMatch(/max-w-measure/);
      node = node.parentElement;
    }
  });
});
