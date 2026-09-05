import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { makeStudyConfig } from '../fixtures/models';
import {
  classifyStudyMutation,
  IDEMPOTENCY_KEY_CONSUMED,
  IDEMPOTENCY_KEY_REUSE,
} from '@/lib/studyMutationClassification';
import { saveStudy } from '@/services/storageService';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const STUDY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EDIT_ID = '4e52c093-96b2-4b56-88a9-330d740a42ea';
const PARENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
const searchParamsMock = vi.hoisted(() => ({
  value: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParamsMock.value,
}));

import StudySetup from '@/components/StudySetup';

const fetchMock = vi.hoisted(() => ({
  fn: vi.fn(),
  posts: [] as Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>,
  authenticated: true,
  createStatus: 200 as number,
  createBody: {} as Record<string, unknown>,
  createImpl: null as null | ((init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>),
}));

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function headerMap(init?: RequestInit): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText('e.g., AI Adoption in Healthcare'), {
    target: { value: 'Idempotent Study' },
  });
  fireEvent.change(screen.getByPlaceholderText('What are you trying to understand?'), {
    target: { value: 'Does the key stay stable?' },
  });
}

async function readyToSave() {
  await waitFor(() => expect(screen.queryByText(/Checking configured AI providers/i)).not.toBeInTheDocument());
  fillRequiredFields();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save Study' })).toBeEnabled());
}

describe('StudySetup create idempotency', () => {
  beforeEach(() => {
    cleanup();
    sessionStorage.clear();
    fetchMock.fn.mockReset();
    fetchMock.posts.length = 0;
    fetchMock.authenticated = true;
    fetchMock.createStatus = 200;
    fetchMock.createBody = {
      study: {
        id: STUDY_ID,
        config: makeStudyConfig({ id: STUDY_ID, name: 'Idempotent Study' }),
      },
      message: 'Study saved successfully',
    };
    fetchMock.createImpl = null;
    routerMock.push.mockReset();
    searchParamsMock.value = new URLSearchParams();

    let minted = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      minted += 1;
      return minted === 1 ? UUID_A : UUID_B;
    });

    fetchMock.fn.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname;
      const method = (init?.method || 'GET').toUpperCase();
      if (path === '/api/auth') {
        return jsonResponse(200, { authenticated: fetchMock.authenticated });
      }
      if (path === '/api/config/status') {
        return jsonResponse(200, {
          mode: 'hosted',
          aiTransport: 'direct',
          hasAnthropicKey: true,
          hasGeminiKey: true,
          hasOpenAiKey: true,
          hasOpenRouterKey: true,
        });
      }
      if (path === '/api/studies' || path.startsWith('/api/studies/')) {
        // M6.1's revision fetch issues a GET on mount for any saved study;
        // this file's subject is which mutation went out with which header,
        // so only mutations are recorded.
        if (method !== 'GET') {
          fetchMock.posts.push({
            url: path,
            method,
            headers: headerMap(init),
            body: init?.body ? JSON.parse(String(init.body)) : null,
          });
        }
        if (fetchMock.createImpl) return fetchMock.createImpl(init);
        return jsonResponse(fetchMock.createStatus, fetchMock.createBody);
      }
      return jsonResponse(404, { error: 'not found' });
    });
    vi.stubGlobal('fetch', fetchMock.fn);

    storeMock.seed({
      studyConfig: null,
      setStudyConfig: vi.fn((config) => {
        storeMock.state.studyConfig = config;
      }),
      setStep: vi.fn(),
      loadExampleStudy: vi.fn(),
      setViewMode: vi.fn(),
      setAiTransport: vi.fn(),
      resetParticipant: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends one UUID v4 Idempotency-Key on create POST and reuses it after 202', async () => {
    fetchMock.createStatus = 202;
    fetchMock.createBody = {
      reconciliationPending: true,
      operationId: 'op-1',
      studyId: STUDY_ID,
      phase: 'pending',
      retryAfterSeconds: 5,
      study: {
        id: STUDY_ID,
        config: makeStudyConfig({ id: STUDY_ID, name: 'Idempotent Study' }),
      },
    };

    render(<StudySetup />);
    await readyToSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));

    await waitFor(() => expect(screen.getByText('Study saved; repair pending')).toBeInTheDocument());
    expect(fetchMock.posts).toHaveLength(1);
    expect(fetchMock.posts[0].method).toBe('POST');
    expect(fetchMock.posts[0].headers['Idempotency-Key']).toBe(UUID_A);
    expect(fetchMock.posts[0].headers['Idempotency-Key']).not.toBe(STUDY_ID);
    expect(fetchMock.posts[0].body).not.toHaveProperty('config.id');

    fireEvent.click(screen.getByRole('button', { name: 'Repair pending' }));
    await waitFor(() => expect(fetchMock.posts).toHaveLength(2));
    expect(fetchMock.posts[1].method).toBe('POST');
    expect(fetchMock.posts[1].headers['Idempotency-Key']).toBe(UUID_A);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('restores the same key across remounts of the same create intent', async () => {
    const first = render(<StudySetup />);
    await readyToSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(fetchMock.posts).toHaveLength(1));
    first.unmount();

    fetchMock.posts.length = 0;
    storeMock.seed({
      ...storeMock.state,
      studyConfig: null,
    });
    render(<StudySetup />);
    await readyToSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(fetchMock.posts).toHaveLength(1));
    expect(fetchMock.posts[0].headers['Idempotency-Key']).toBe(UUID_A);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('mints a new key for a follow-up create intent', async () => {
    render(<StudySetup />);
    await readyToSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(fetchMock.posts).toHaveLength(1));
    expect(fetchMock.posts[0].headers['Idempotency-Key']).toBe(UUID_A);
    cleanup();

    sessionStorage.setItem('prefillStudyConfig', JSON.stringify({
      name: 'Follow-up',
      researchQuestion: 'What next?',
      parentStudyId: PARENT_ID,
      parentStudyName: 'Parent',
    }));
    searchParamsMock.value = new URLSearchParams('prefill=followup');
    storeMock.seed({
      studyConfig: null,
      setStudyConfig: vi.fn(),
      setStep: vi.fn(),
      loadExampleStudy: vi.fn(),
      setViewMode: vi.fn(),
      setAiTransport: vi.fn(),
      resetParticipant: vi.fn(),
    });
    fetchMock.posts.length = 0;
    render(<StudySetup />);
    await waitFor(() => expect(screen.queryByText(/Checking configured AI providers/i)).not.toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('e.g., AI Adoption in Healthcare'), {
      target: { value: 'Follow-up' },
    });
    fireEvent.change(screen.getByPlaceholderText('What are you trying to understand?'), {
      target: { value: 'What next?' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Study' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(fetchMock.posts).toHaveLength(1));
    expect(fetchMock.posts[0].headers['Idempotency-Key']).toBe(UUID_B);
  });

  it('never sends Idempotency-Key on edit PUT', async () => {
    storeMock.seed({
      ...storeMock.state,
      studyConfig: makeStudyConfig({
        id: EDIT_ID,
        name: 'Existing study',
        researchQuestion: 'Already saved?',
      }),
    });
    render(<StudySetup />);
    await waitFor(() => expect(screen.queryByText(/Checking configured AI providers/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit Study Details' }));
    fireEvent.change(screen.getByPlaceholderText('e.g., AI Adoption in Healthcare'), {
      target: { value: 'Existing study edited' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Study' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Update Study' }));
    await waitFor(() => expect(fetchMock.posts).toHaveLength(1));
    expect(fetchMock.posts[0].method).toBe('PUT');
    expect(fetchMock.posts[0].url).toBe(`/api/studies/${EDIT_ID}`);
    expect(fetchMock.posts[0].headers['Idempotency-Key']).toBeUndefined();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('ignores a stale create response after a new intent starts', async () => {
    let release: ((value: ReturnType<typeof jsonResponse>) => void) | null = null;
    fetchMock.createImpl = async () => new Promise((resolve) => {
      release = resolve;
    });

    const view = render(<StudySetup />);
    await readyToSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(fetchMock.posts).toHaveLength(1));

    sessionStorage.setItem('prefillStudyConfig', JSON.stringify({
      name: 'Follow-up after stale',
      researchQuestion: 'New intent?',
      parentStudyId: PARENT_ID,
      parentStudyName: 'Parent',
    }));
    searchParamsMock.value = new URLSearchParams('prefill=followup');
    view.rerender(<StudySetup />);
    await waitFor(() => expect(screen.getByText('Follow-up Study')).toBeInTheDocument());

    release!(jsonResponse(200, {
      study: { id: STUDY_ID, config: makeStudyConfig({ id: STUDY_ID, name: 'Stale' }) },
    }));

    await waitFor(() => expect(routerMock.push).not.toHaveBeenCalled());
    expect(screen.queryByText('Save Failed')).not.toBeInTheDocument();

    fetchMock.createImpl = null;
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    await waitFor(() => expect(fetchMock.posts).toHaveLength(2));
    expect(fetchMock.posts[0].headers['Idempotency-Key']).toBe(UUID_A);
    expect(fetchMock.posts[1].headers['Idempotency-Key']).toBe(UUID_B);
    expect(fetchMock.posts[1].headers['Idempotency-Key']).not.toBe(
      fetchMock.posts[0].headers['Idempotency-Key']
    );
  });

  it('surfaces idempotency reuse and consumed as errors, not protocol failures', async () => {
    expect(classifyStudyMutation(409, { code: IDEMPOTENCY_KEY_REUSE }).outcome).toBe('error');
    expect(classifyStudyMutation(409, { code: IDEMPOTENCY_KEY_CONSUMED }).outcome).toBe('error');
    expect(classifyStudyMutation(202, { reconciliationPending: true, studyId: STUDY_ID }).outcome)
      .toBe('pending-create');

    fetchMock.createStatus = 409;
    fetchMock.createBody = { code: IDEMPOTENCY_KEY_REUSE };
    render(<StudySetup />);
    await readyToSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save Study' }));
    expect(await screen.findByText(/already used with a different study/i)).toBeInTheDocument();
  });

  it('forwards Idempotency-Key from saveStudy on create and omits it on update', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, {
      study: { id: STUDY_ID, config: makeStudyConfig({ id: STUDY_ID }) },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    await saveStudy({
      config: makeStudyConfig({ name: 'Create' }),
      idempotencyKey: UUID_A,
    });
    expect(fetchSpy).toHaveBeenCalledWith('/api/studies', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'Idempotency-Key': UUID_A,
      }),
    }));

    fetchSpy.mockClear();
    await saveStudy({
      config: makeStudyConfig({ id: EDIT_ID, name: 'Edit' }),
      updateStudyId: EDIT_ID,
      idempotencyKey: UUID_A,
    });
    const updateInit = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(fetchSpy.mock.calls[0][0]).toBe(`/api/studies/${EDIT_ID}`);
    expect(updateInit.method).toBe('PUT');
    expect(headerMap(updateInit)['Idempotency-Key']).toBeUndefined();
  });
});
