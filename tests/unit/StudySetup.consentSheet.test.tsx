import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * M7: the authored consent text renders as a serif reading sheet, showing
 * the generated default when the field is blank so a researcher can check
 * the exact text their participants will sign before saving.
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import StudySetup from '@/components/StudySetup';

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

describe('StudySetup consent reading sheet', () => {
  it('previews the generated default from the research question when the field is blank', () => {
    render(<StudySetup />);

    fireEvent.change(screen.getByPlaceholderText('What are you trying to understand?'), {
      target: { value: 'How do people resume research?' },
    });

    const sheet = screen.getByText('What participants will read').closest('div')!;
    expect(sheet).toHaveTextContent('How do people resume research?');
    expect(sheet).toHaveTextContent('You may stop at any time. Do you consent to participate?');
    expect(sheet.textContent).not.toMatch(/\[/);
  });

  it('replaces the sheet text as the researcher types into the textarea', () => {
    render(<StudySetup />);

    fireEvent.change(screen.getByPlaceholderText('What are you trying to understand?'), {
      target: { value: 'How do people resume research?' },
    });
    fireEvent.change(screen.getByLabelText('Consent Text'), {
      target: { value: 'Custom consent copy for this study.' },
    });

    const sheet = screen.getByText('What participants will read').closest('div')!;
    expect(sheet).toHaveTextContent('Custom consent copy for this study.');
    expect(sheet).not.toHaveTextContent('How do people resume research?');
  });

  it('renders the sheet text in the serif Verbatim primitive, wrapping pre-formatted whitespace', () => {
    render(<StudySetup />);

    fireEvent.change(screen.getByPlaceholderText('What are you trying to understand?'), {
      target: { value: 'How do people resume research?' },
    });

    const sheet = screen.getByText('What participants will read').closest('div')!;
    const verbatim = sheet.querySelector('.font-serif');
    expect(verbatim).not.toBeNull();
    expect(verbatim).toHaveClass('whitespace-pre-wrap');
  });
});
