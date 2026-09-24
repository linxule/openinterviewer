import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { useStore } from '@/store';

// A participant session kept in memory only is lost to a document load (a
// reload, or Next.js turning a failed Flight navigation into a document
// navigation). Each participant step must then say how to recover rather than
// show a researcher-facing "No study configured" (issue #52).
const services = vi.hoisted(() => ({
  getInterviewGreeting: vi.fn(),
  generateInterviewResponse: vi.fn(),
  synthesizeInterview: vi.fn(),
  saveCompletedInterview: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/services/interviewApi', () => ({
  getInterviewGreeting: services.getInterviewGreeting,
  generateInterviewResponse: services.generateInterviewResponse,
  synthesizeInterview: services.synthesizeInterview,
  ApiRequestError: class ApiRequestError extends Error {},
}));
vi.mock('@/services/storageService', () => ({ saveCompletedInterview: services.saveCompletedInterview }));

import Consent from '@/components/Consent';
import InterviewChat from '@/components/InterviewChat';
import Synthesis from '@/components/Synthesis';
import NoSessionNotice from '@/components/NoSessionNotice';

const HEADING = 'This interview is not open in this tab';

beforeEach(() => {
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
  vi.clearAllMocks();
});

describe('participant step without a session in this tab', () => {
  it.each([
    ['consent', Consent],
    ['interview', InterviewChat],
    ['synthesis', Synthesis],
  ])('%s tells the participant to reopen their link and makes no request', (_step, Step) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<Step />);

    expect(screen.getByRole('heading', { name: HEADING })).toBeInTheDocument();
    expect(screen.getByText(/open the link you were given again/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Object.values(services).every((service) => service.mock.calls.length === 0)).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('is not in the server HTML, which is rendered before the tab state is read', () => {
    const html = renderToString(<NoSessionNotice />);
    expect(html).not.toContain(HEADING);
    expect(html).toContain('<main');
  });
});
