import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { makeStudyConfig } from '../fixtures/models';

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
import { useStudyDraft } from '@/components/studySetup/useStudyDraft';
import { INTERVIEWER_MANNER_NEUTRAL, INTERVIEWER_MANNER_WARM } from '@/lib/interviewerManner';

const SECTION_IDS = [
  'study-details',
  'profile-fields',
  'core-questions',
  'topic-areas',
  'ai-provider',
  'interview-structure',
  'interviewer-manner',
  'link-settings',
  'consent-text',
  'thank-you-text',
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
    // §6's rule is "no decorative icons", not "no icons": M8.1 puts a
    // functional Icon in four remove/dismiss controls. Assert the rule
    // itself — every svg is inside a button, aria-hidden, unlabeled, and no
    // heading or section carries one directly — rather than a raw count,
    // so the assertion survives the next functional icon and still fails on
    // a decorative one.
    const { container } = render(<StudySetup />);

    fireEvent.click(screen.getByRole('button', { name: /Current Role/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Topic' }));

    const svgs = Array.from(container.querySelectorAll('svg'));
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg.closest('button')).not.toBeNull();
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).not.toHaveAttribute('role');
      expect(svg).not.toHaveAttribute('title');
      expect(svg).not.toHaveAttribute('aria-label');
    }
    for (const heading of container.querySelectorAll('h2, section')) {
      expect(heading.querySelector(':scope > svg')).toBeNull();
    }

    const removeField = screen.getByRole('button', { name: 'Remove Current Role' });
    expect(removeField.querySelectorAll('svg')).toHaveLength(1);
    const removeQuestion = screen.getByRole('button', { name: 'Remove question 2' });
    expect(removeQuestion.querySelectorAll('svg')).toHaveLength(1);
    const removeTopic = screen.getByRole('button', { name: 'Remove topic 2' });
    expect(removeTopic.querySelectorAll('svg')).toHaveLength(1);
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

describe('StudySetup document mode (F1: read-mode for saved studies)', () => {
  const SAVED_ID = '4e52c093-96b2-4b56-88a9-330d740a42ea';

  function seedSavedStudy(overrides: Record<string, unknown> = {}) {
    storeMock.seed({
      studyConfig: makeStudyConfig({ id: SAVED_ID, name: 'Saved Study', ...overrides }),
      setStudyConfig: vi.fn(),
      setStep: vi.fn(),
      loadExampleStudy: vi.fn(),
      setViewMode: vi.fn(),
      setAiTransport: vi.fn(),
      resetParticipant: vi.fn(),
    });
  }

  it('exposes all ten sections in the index, and each behind its own Edit control that reveals its fields independently', () => {
    seedSavedStudy();
    render(<StudySetup />);

    const nav = screen.getByRole('navigation', { name: 'Study sections' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(SECTION_IDS.length);
    for (const id of SECTION_IDS) {
      expect(document.querySelector(`#${id}`)).toBeInTheDocument();
    }

    for (const label of [
      'Study Details', 'Profile Fields', 'Core Questions', 'Topic Areas',
      'AI Provider', 'Interview Structure', 'Interviewer Manner', 'Link Settings', 'Consent Text', 'Thank-You Screen',
    ]) {
      expect(screen.getByRole('button', { name: `Edit ${label}` })).toBeInTheDocument();
    }

    // No section renders a form control before its Edit is clicked.
    expect(screen.queryByPlaceholderText('e.g., AI Adoption in Healthcare')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Question 1...')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Link Expiration')).not.toBeInTheDocument();

    // Clicking one section's Edit reveals only that section's fields.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Core Questions' }));
    expect(screen.getByPlaceholderText('Question 1...')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('e.g., AI Adoption in Healthcare')).not.toBeInTheDocument();
  });

  it('does not dirty the draft when opening a section', () => {
    seedSavedStudy();
    render(<StudySetup />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Study Details' }));

    // isDirty untouched by opening a section: a no-op save must stay impossible.
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled();
  });

  it('gives core-question read rows measure and profile-field read rows none (A2)', () => {
    seedSavedStudy({ coreQuestions: ['First question?', 'Second question?'] });
    render(<StudySetup />);

    const questionText = screen.getByText('First question?');
    expect(questionText.className).toMatch(/max-w-measure/);

    const fieldLabel = screen.getByText('Current Role');
    let node: HTMLElement | null = fieldLabel;
    let sawMeasure = false;
    while (node && node !== document.body) {
      if (/max-w-measure/.test(node.className)) sawMeasure = true;
      node = node.parentElement;
    }
    expect(sawMeasure).toBe(false);
  });

  it('renders the revision fact block in mono with the README sentences verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path === '/api/auth') {
        return { ok: true, status: 200, json: async () => ({ authenticated: false }) };
      }
      if (path === `/api/studies/${SAVED_ID}`) {
        return { ok: true, status: 200, json: async () => ({ study: { revision: 3 } }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }));
    seedSavedStudy();
    render(<StudySetup />);

    const revisionText = await screen.findByText('Study revision 3');
    expect(revisionText.tagName).toBe('SPAN');
    expect(revisionText.className).toMatch(/font-mono/);
    expect(screen.getByText(/Editing a study advances its revision and invalidates links and participant sessions issued/)).toBeInTheDocument();
    expect(screen.getByText(/Generate and distribute a new link after a consequential edit\./)).toBeInTheDocument();
  });

  it('omits the revision line on a failed fetch without blocking editing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path === '/api/auth') {
        return { ok: true, status: 200, json: async () => ({ authenticated: false }) };
      }
      if (path === `/api/studies/${SAVED_ID}`) {
        return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }));
    seedSavedStudy();
    render(<StudySetup />);

    // Give the failed fetch a turn to resolve, then confirm no placeholder,
    // no error surfaced, and the form is still fully editable.
    await waitFor(() => expect(screen.getByText('Revision')).toBeInTheDocument());
    expect(screen.queryByText(/Study revision/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Study Details' })).toBeInTheDocument();
  });

  it('renders no revision block and no Edit control for a new study', () => {
    storeMock.seed({
      studyConfig: null,
      setStudyConfig: vi.fn(),
      setStep: vi.fn(),
      loadExampleStudy: vi.fn(),
      setViewMode: vi.fn(),
      setAiTransport: vi.fn(),
      resetParticipant: vi.fn(),
    });
    render(<StudySetup />);

    expect(screen.queryByText('Revision')).not.toBeInTheDocument();
    expect(screen.queryByText(/Study revision/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
  });
});

describe('StudySetup Thank-You Screen section (slice P §P12.5)', () => {
  const SAVED_ID = '4e52c093-96b2-4b56-88a9-330d740a42ea';

  function seedSavedStudy(overrides: Record<string, unknown> = {}) {
    storeMock.seed({
      studyConfig: makeStudyConfig({ id: SAVED_ID, name: 'Saved Study', ...overrides }),
      setStudyConfig: vi.fn(),
      setStep: vi.fn(),
      loadExampleStudy: vi.fn(),
      setViewMode: vi.fn(),
      setAiTransport: vi.fn(),
      resetParticipant: vi.fn(),
    });
  }

  function stubAuthenticatedFetch() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path === '/api/auth') {
        return { ok: true, status: 200, json: async () => ({ authenticated: true }) };
      }
      if (path === '/api/config/status') {
        return {
          ok: true, status: 200,
          json: async () => ({
            mode: 'hosted', aiTransport: 'direct',
            hasGeminiKey: true, hasAnthropicKey: true, hasOpenAiKey: true, hasOpenRouterKey: true,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }));
  }

  it('renders its own Edit control, and the read sheet defaults for a blank draft', () => {
    seedSavedStudy();
    render(<StudySetup />);

    expect(screen.getByRole('button', { name: 'Edit Thank-You Screen' })).toBeInTheDocument();
    expect(screen.getByText('What participants will read after they finish')).toBeInTheDocument();
    expect(screen.getByText(/Thank you for taking part\./)).toBeInTheDocument();
  });

  it('"Insert a template" fills the textarea with bracketed text', () => {
    seedSavedStudy();
    render(<StudySetup />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Thank-You Screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert a template' }));

    const textarea = screen.getByLabelText('Thank-You Screen') as HTMLTextAreaElement;
    expect(textarea.value).toContain('[study name]');
  });

  it('saving the template unedited surfaces the placeholder error', async () => {
    stubAuthenticatedFetch();
    seedSavedStudy();
    render(<StudySetup />);

    await waitFor(() => expect(screen.queryByText(/Checking configured AI providers/i)).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit Thank-You Screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert a template' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Study' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Update Study' }));
    expect(await screen.findByText(/cannot contain a bracketed placeholder/i)).toBeInTheDocument();
  });
});


describe('StudySetup interviewer manner', () => {
  it('indexes structure and manner and replaces instructions with editable presets', () => {
    render(<StudySetup />);
    const nav = screen.getByRole('navigation', { name: 'Study sections' });
    expect(within(nav).getByRole('link', { name: 'Interview Structure' })).toHaveAttribute('href', '#interview-structure');
    expect(within(nav).getByRole('link', { name: 'Interviewer Manner' })).toHaveAttribute('href', '#interviewer-manner');
    expect(screen.queryByText('Default manner: brief, open, non-leading questions, one at a time.')).not.toBeInTheDocument();
    expect(screen.getByText('Start from a preset')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use the Concrete incidents preset' })).toHaveClass('underline', 'min-h-11');
    const textarea = screen.getByLabelText('Instructions to the interviewer');
    expect(textarea).toHaveAttribute('rows', '6');
    expect(textarea).toHaveAttribute('maxlength', '4000');
    fireEvent.click(screen.getByRole('button', { name: 'Use the Neutral preset' }));
    expect(textarea).toHaveValue(INTERVIEWER_MANNER_NEUTRAL);
    expect(screen.queryByText(INTERVIEWER_MANNER_NEUTRAL, { selector: 'p' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use the Warm preset' }));
    expect(textarea).toHaveValue(INTERVIEWER_MANNER_WARM);
    expect(screen.getByText(new RegExp(`${INTERVIEWER_MANNER_WARM.length} of 4000 characters`))).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: 'Ask in everyday words.' } });
    expect(screen.queryByText('Ask in everyday words.', { selector: 'p' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use the Neutral preset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(textarea).toHaveValue('Ask in everyday words.');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use the Warm preset' }));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: '' } });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByText('Default manner: brief, open, non-leading questions, one at a time.')).not.toBeInTheDocument();
  });

  it('shows the default read sheet for a saved study without instructions', () => {
    storeMock.state.studyConfig = makeStudyConfig({ id: '4e52c093-96b2-4b56-88a9-330d740a42ea' });
    render(<StudySetup />);
    expect(screen.getByText('Your instructions to the interviewer')).toBeInTheDocument();
    expect(screen.getByText('Default manner: brief, open, non-leading questions, one at a time.')).toHaveClass('font-sans', 'text-ink-500');
  });

  it('loads saved manner into the read sheet and dirties the draft only when edited', () => {
    storeMock.state.studyConfig = makeStudyConfig({
      id: '4e52c093-96b2-4b56-88a9-330d740a42ea', interviewerInstructions: 'Use everyday words.',
    });
    render(<StudySetup />);
    expect(screen.getByText('Use everyday words.', { selector: 'p' })).toHaveClass('font-sans');
    expect(screen.queryByLabelText('Instructions to the interviewer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Interviewer Manner' }));
    expect(screen.getByLabelText('Instructions to the interviewer')).toHaveValue('Use everyday words.');
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use the Warm preset' }));
    expect(screen.getByRole('button', { name: 'Update Study' })).toBeInTheDocument();
  });
});


describe('interviewer manner draft lifecycle mirrors thankYouText', () => {
  it('loads, prefills, resets, trims payloads, and omits blank text identically', () => {
    const { result } = renderHook(() => useStudyDraft(makeStudyConfig({
      thankYouText: 'Initial text.', interviewerInstructions: 'Initial text.',
    })));
    expect(result.current.interviewerInstructions).toBe(result.current.thankYouText);
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.hydratePrefill({ thankYouText: 'Prefill.', interviewerInstructions: 'Prefill.' }));
    expect(result.current.interviewerInstructions).toBe('Prefill.');
    expect(result.current.interviewerInstructions).toBe(result.current.thankYouText);
    act(() => result.current.hydratePrefill({ thankYouText: '', interviewerInstructions: '' }));
    expect(result.current.interviewerInstructions).toBe('Prefill.');
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.syncFromStudyConfig(makeStudyConfig()));
    expect(result.current.interviewerInstructions).toBe('');
    expect(result.current.interviewerInstructions).toBe(result.current.thankYouText);
    expect(result.current.buildConfig('create')).not.toHaveProperty('interviewerInstructions');
    act(() => {
      result.current.setThankYouText('  Edited text.  ');
      result.current.setInterviewerInstructions('  Edited text.  ');
    });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.buildConfig('create')).toMatchObject({ thankYouText: 'Edited text.', interviewerInstructions: 'Edited text.' });
    act(() => {
      result.current.setThankYouText('  ');
      result.current.setInterviewerInstructions('  ');
    });
    expect(result.current.buildConfig('create')).not.toHaveProperty('interviewerInstructions');
    expect(result.current.buildConfig('create')).not.toHaveProperty('thankYouText');
    expect(result.current.buildConfig('create')).not.toHaveProperty('researcherContact');
    expect(result.current.buildConfig('update')).toMatchObject({ interviewerInstructions: '', thankYouText: '' });
  });
});

it('sends empty strings when clearing saved text and disables Preview until saved', async () => {
  const config = makeStudyConfig({
    id: '4e52c093-96b2-4b56-88a9-330d740a42ea',
    interviewerInstructions: 'Old manner.', thankYouText: 'Old thanks.',
  });
  storeMock.state.studyConfig = config;
  let sentConfig: Record<string, unknown> | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/api/auth') return new Response(JSON.stringify({ authenticated: true }));
    if (path === '/api/config/status') return new Response(JSON.stringify({
      mode: 'hosted', aiTransport: 'direct', hasGeminiKey: true, hasAnthropicKey: true, hasOpenAiKey: true, hasOpenRouterKey: true,
    }));
    if (path === `/api/studies/${config.id}`) {
      if (init?.method === 'PUT') sentConfig = JSON.parse(String(init.body)).config;
      return new Response(JSON.stringify({ study: { id: config.id, config, revision: 1 } }));
    }
    return new Response('{}', { status: 404 });
  }));
  render(<StudySetup />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview Saved Study' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Edit Interviewer Manner' }));
  fireEvent.change(screen.getByLabelText('Instructions to the interviewer'), { target: { value: '  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit Thank-You Screen' }));
  fireEvent.change(screen.getByLabelText('Thank-You Screen'), { target: { value: '  ' } });
  expect(screen.getByRole('button', { name: 'Preview Saved Study' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Update Study' }));
  await waitFor(() => expect(sentConfig).toMatchObject({ interviewerInstructions: '', thankYouText: '' }));
});
