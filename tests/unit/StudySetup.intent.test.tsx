import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StudyConfig } from '@/types';
import { makeStudyConfig } from '../fixtures/models';
import { researcherDraftKey, writeResearcherDraft } from '@/lib/researcherStudyDraft';
import { UUID_V4 } from '@/lib/uuid';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const context = vi.hoisted(() => ({
  params: new URLSearchParams(),
  state: {} as Record<string, unknown>,
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: context.push }), useSearchParams: () => context.params }));
vi.mock('@/store', () => ({ useStore: Object.assign(() => context.state, { getState: () => context.state }) }));

import StudySetup from '@/components/StudySetup';

let studies: Record<string, StudyConfig>;
let revisions: Record<string, number>;
let mutations: { url: string; method: string; body: Record<string, unknown>; key: string | null }[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  sessionStorage.clear();
  context.params = new URLSearchParams();
  context.push.mockReset();
  studies = {
    [A]: makeStudyConfig({ id: A, name: 'Live study A', description: 'A description', interviewerInstructions: 'A manner', researcherContact: 'A contact', linksEnabled: false }),
    [B]: makeStudyConfig({ id: B, name: 'Live study B', description: '', coreQuestions: [], topicAreas: [], profileSchema: [], interviewerInstructions: '', researcherContact: '' }),
  };
  revisions = { [A]: 1, [B]: 2 };
  mutations = [];
  context.state = {
    studyConfig: studies[A], setStudyConfig: vi.fn(config => { context.state.studyConfig = config; }),
    setStep: vi.fn(), loadExampleStudy: vi.fn(), setViewMode: vi.fn(), setAiTransport: vi.fn(), resetParticipant: vi.fn(),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth') return json({ authenticated: true });
    if (url === '/api/config/status') return json({ mode: 'standalone', aiTransport: 'direct', hasGeminiKey: true, hasAnthropicKey: true, hasOpenAiKey: true, hasOpenRouterKey: true });
    if (init?.method === 'POST' || init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      const key = new Headers(init.headers).get('Idempotency-Key');
      mutations.push({ url, method: init.method, body, key });
      // Match the real create route's admission contract, not a permissive fake.
      if (init.method === 'POST' && (!key || !UUID_V4.test(key))) return json({ error: 'A UUID v4 Idempotency-Key is required.' }, 400);
      const id = init.method === 'POST' ? B : url.split('/').at(-1)!;
      const config = { ...body.config, id, createdAt: Date.now() };
      return json({ study: { id, config, revision: 3 } });
    }
    const id = url.split('/').at(-1)!;
    return studies[id] ? json({ study: { id, config: studies[id], revision: revisions[id] } }) : json({ error: 'Study not found' }, 404);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load Example' })).toBeEnabled());
  await waitFor(() => expect(context.state.setAiTransport).toHaveBeenCalledWith('direct'));
}

function fillNew(name: string) {
  fireEvent.change(screen.getByLabelText('Study Name *'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Research Question *'), { target: { value: 'New question?' } });
}

describe('researcher study identity and draft lifecycle', () => {
  it('New Study after viewing A is blank and saves a distinct create, never PUT A', async () => {
    render(<StudySetup />);
    await ready();
    expect(screen.getByLabelText('Study Name *')).toHaveValue('');
    expect(screen.getByLabelText('Instructions to the interviewer')).toHaveValue('');
    fillNew('Brand new B');
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({ url: '/api/studies', method: 'POST' });
    expect(mutations[0].body.config).not.toHaveProperty('id');
    expect(mutations[0].body.config).toMatchObject({ name: 'Brand new B', linksEnabled: true });
    expect(studies[A].name).toBe('Live study A');
  });

  it('a confirmed create retires its receipt before the next distinct New Study', async () => {
    const first = render(<StudySetup />);
    await ready();
    fillNew('First new study');
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(context.push).toHaveBeenCalledWith(`/studies/${B}`));
    const firstKey = mutations[0].key;
    first.unmount();
    render(<StudySetup />);
    await ready();
    fillNew('Second new study');
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1].key).not.toBe(firstKey);
  });

  it('edit B replaces every A field, ignores stale prefill, and reloads without it', async () => {
    context.params = new URLSearchParams(`prefill=edit&studyId=${B}`);
    sessionStorage.setItem('prefillStudyConfig', JSON.stringify(studies[A]));
    const first = render(<StudySetup />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Study Details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Interviewer Manner' }));
    expect(screen.getByLabelText('Study Name *')).toHaveValue('Live study B');
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('');
    expect(screen.getByLabelText('Researcher Contact (optional)')).toHaveValue('');
    expect(screen.getByLabelText('Instructions to the interviewer')).toHaveValue('');
    sessionStorage.removeItem('prefillStudyConfig');
    first.unmount();
    render(<StudySetup />);
    await ready();
    expect(screen.getByText('Live study B')).toBeInTheDocument();
    expect(screen.getByText('Study revision 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview Saved Study' })).toBeEnabled();
  });

  it('duplicate copies configuration only and cannot preview or touch the source', async () => {
    const originalSource = structuredClone(studies[A]);
    context.params = new URLSearchParams(`prefill=duplicate&studyId=${A}`);
    render(<StudySetup />);
    await ready();
    expect(screen.getByLabelText('Study Name *')).toHaveValue('Live study A — test');
    expect(screen.getByLabelText('Instructions to the interviewer')).toHaveValue('A manner');
    expect(screen.getByRole('button', { name: 'Preview Saved Study' })).toBeDisabled();
    expect(screen.getByText(/Only the study configuration was copied/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({ url: '/api/studies', method: 'POST' });
    expect(mutations[0].key).toMatch(UUID_V4);
    await waitFor(() => expect(context.push).toHaveBeenCalledWith(`/studies/${B}`));
    expect(context.state.studyConfig).toMatchObject({ id: B, name: 'Live study A — test' });
    expect((context.state.studyConfig as StudyConfig).id).not.toBe(A);
    expect(sessionStorage.getItem('oi:create-idempotency-state')).toBeNull();
    const config = mutations[0].body.config;
    expect(config).not.toHaveProperty('id');
    expect(config).not.toHaveProperty('parentStudyId');
    expect(config).not.toHaveProperty('interviewCount');
    expect(config).toMatchObject({ linksEnabled: true });
    expect(studies[A]).toEqual(originalSource);
  });

  it('keeps edit drafts isolated from New Study and restores/discards raw unfinished fields', async () => {
    context.params = new URLSearchParams(`prefill=edit&studyId=${B}`);
    const view = render(<StudySetup />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Study Details' }));
    fireEvent.change(screen.getByLabelText('Study Name *'), { target: { value: 'Unfinished B' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview Saved Study' })).toBeDisabled();
    context.params = new URLSearchParams();
    view.rerender(<StudySetup />);
    await ready();
    expect(screen.getByLabelText('Study Name *')).toHaveValue('');
    fillNew('Unfinished new study');
    context.params = new URLSearchParams(`prefill=edit&studyId=${B}`);
    view.rerender(<StudySetup />);
    await ready();
    expect(screen.getByText('Restored unsaved draft')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Study Details' }));
    expect(screen.getByLabelText('Study Name *')).toHaveValue('Unfinished B');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(screen.getByText('Live study B')).toBeInTheDocument();
    expect(sessionStorage.getItem(researcherDraftKey('edit', B))).toBeNull();
    expect(mutations).toHaveLength(0);
  });

  it('a stale restored revision requires review and sends the canonical expectedRevision', async () => {
    context.params = new URLSearchParams(`prefill=edit&studyId=${B}`);
    writeResearcherDraft(researcherDraftKey('edit', B), { ...studies[B], name: 'Old draft B' }, 1);
    render(<StudySetup />);
    await ready();
    expect(screen.getByRole('button', { name: 'Update Study' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Review current saved study' })).toHaveAttribute('href', `/studies/${B}?tab=settings`);
    expect(JSON.parse(sessionStorage.getItem(researcherDraftKey('edit', B))!).revision).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'I reviewed the current revision' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update Study' }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({ url: `/api/studies/${B}`, method: 'PUT', body: { expectedRevision: 2 } });
  });

  it('a delayed canonical A load cannot fill the newly selected B form', async () => {
    let answer!: (response: Response) => void;
    const original = fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input) === `/api/studies/${A}`
      ? new Promise<Response>(resolve => { answer = resolve; }) : original(input, init)));
    context.params = new URLSearchParams(`prefill=edit&studyId=${A}`);
    const view = render(<StudySetup />);
    context.params = new URLSearchParams(`prefill=edit&studyId=${B}`);
    view.rerender(<StudySetup />);
    await ready();
    await act(async () => answer(json({ study: { id: A, config: studies[A], revision: 1 } })));
    expect(screen.getByText('Live study B')).toBeInTheDocument();
    expect(screen.queryByText('Live study A')).not.toBeInTheDocument();
  });
  it('reports a confirmed update conflict instead of silently leaving the draft unsaved', async () => {
    context.params = new URLSearchParams(`prefill=edit&studyId=${B}`);
    const original = fetch;
    let writes = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return original(input, init);
      writes += 1;
      return Promise.resolve(writes === 1
        ? json({ requiresConfirmation: true, warning: 'Existing interviews will remain historical.' }, 409)
        : json({ error: 'This study changed since you opened it. Reload before saving.' }, 409));
    }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StudySetup />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Study Details' }));
    fireEvent.change(screen.getByLabelText('Study Name *'), { target: { value: 'Changed B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Study' }));
    expect(await screen.findByText('This study changed since you opened it. Reload before saving.')).toBeInTheDocument();
    expect(writes).toBe(2);
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(context.push).not.toHaveBeenCalled();
  });

  it('storage write failure keeps the draft editable in memory and visibly warns before page loss', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage unavailable', 'QuotaExceededError'); });
    render(<StudySetup />);
    await ready();
    fillNew('Memory-only draft');
    expect(screen.getByText(/Browser storage is unavailable/)).toBeInTheDocument();
    expect(screen.getByLabelText('Study Name *')).toHaveValue('Memory-only draft');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(mutations).toHaveLength(1));
  });

  it('holds the submitted version against queued edits during a deferred save and unlocks after failure', async () => {
    context.params = new URLSearchParams(`prefill=edit&studyId=${B}`);
    let answer!: (response: Response) => void;
    let submitted!: StudyConfig;
    const original = fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return original(input, init);
      submitted = JSON.parse(String(init.body)).config;
      return new Promise<Response>(resolve => { answer = resolve; });
    }));
    render(<StudySetup />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Study Details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Interviewer Manner' }));
    fireEvent.change(screen.getByLabelText('Study Name *'), { target: { value: 'Submitted version B' } });
    fireEvent.change(screen.getByLabelText('Instructions to the interviewer'), { target: { value: 'Submitted manner.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Study' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saving this version.');
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Load Example' })).toBeDisabled();
    expect(screen.getByLabelText('Study Name *')).toBeDisabled();
    expect(screen.getByLabelText('Instructions to the interviewer')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use the Warm preset' })).toBeDisabled();
    // Native disabled controls prevent gestures; also reject already-queued DOM events.
    fireEvent.change(screen.getByLabelText('Study Name *'), { target: { value: 'Late unsent B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use the Warm preset' }));
    expect(screen.getByLabelText('Study Name *')).toHaveValue('Submitted version B');
    expect(screen.getByLabelText('Instructions to the interviewer')).toHaveValue('Submitted manner.');
    const keptDraft = JSON.parse(sessionStorage.getItem(researcherDraftKey('edit', B))!).config;
    expect(keptDraft).toMatchObject({ name: 'Submitted version B', interviewerInstructions: 'Submitted manner.' });
    expect(submitted).toMatchObject({ name: 'Submitted version B', interviewerInstructions: 'Submitted manner.' });
    await act(async () => { answer(json({ error: 'Synthetic save failure' }, 500)); });
    expect(await screen.findByText('Synthetic save failure')).toBeInTheDocument();
    expect(screen.getByLabelText('Study Name *')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Study Name *'), { target: { value: 'Retry version B' } });
    expect(screen.getByLabelText('Study Name *')).toHaveValue('Retry version B');
    expect(JSON.parse(sessionStorage.getItem(researcherDraftKey('edit', B))!).config.name).toBe('Retry version B');
    expect(context.push).not.toHaveBeenCalled();
  });

});
