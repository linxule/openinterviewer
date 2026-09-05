import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

import Consent from '@/components/Consent';

beforeEach(() => {
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
  navigation.push.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Consent researcher contact', () => {
  it('echoes the researcher contact inside the data notice, not in mono', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-contact', researcherContact: 'Dr. Amara Osei · research@university.edu' }),
      'participant-handle-contact-123456'
    );

    render(<Consent />);

    expect(screen.getByText(/Researcher contact:/)).toBeInTheDocument();
    const value = screen.getByText('Dr. Amara Osei · research@university.edu');
    expect(value).toBeInTheDocument();
    expect(value).not.toHaveClass('font-mono');
    // Still inside the same data-notice block as the rest of the disclosure.
    expect(screen.getByText(/Contact the researcher for retention, access, and/).closest('div'))
      .toHaveTextContent('Researcher contact: Dr. Amara Osei · research@university.edu');
  });

  it('omits the researcher contact line when the study has none', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-no-contact' }),
      'participant-handle-no-contact-123456'
    );

    render(<Consent />);

    expect(screen.queryByText(/Researcher contact:/)).not.toBeInTheDocument();
  });
});
