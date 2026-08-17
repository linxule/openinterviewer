import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));

const storageMock = vi.hoisted(() => ({
  deleteStudy: vi.fn(),
  getAllStudies: vi.fn(),
  reconcileStudyOperations: vi.fn(),
}));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@/services/storageService');
  return {
    ...actual,
    deleteStudy: storageMock.deleteStudy,
    getAllStudies: storageMock.getAllStudies,
    reconcileStudyOperations: storageMock.reconcileStudyOperations,
  };
});

const storeMock = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));
vi.mock('@/store', () => ({ useStore: () => storeMock.state }));

import StudyList from '@/components/StudyList';
import StudySetup from '@/components/StudySetup';

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getAllStudies.mockResolvedValue({ studies: [], outcome: { status: 'ok' } });
  storageMock.reconcileStudyOperations.mockResolvedValue({
    success: true,
    completed: 0,
    rolledBack: 0,
    stillPending: 0,
  });
  storeMock.state = {
    studyConfig: null,
    setStudyConfig: vi.fn(),
    setStep: vi.fn(),
    loadExampleStudy: vi.fn(),
    setViewMode: vi.fn(),
    setAiTransport: vi.fn(),
  };
});

describe('hosted study operation recovery UI', () => {
  it('runs reconciliation before loading the hosted studies workspace', async () => {
    const calls: string[] = [];
    storageMock.reconcileStudyOperations.mockImplementation(async () => {
      calls.push('reconcile');
      return { success: true, completed: 1, rolledBack: 0, stillPending: 0 };
    });
    storageMock.getAllStudies.mockImplementation(async () => {
      calls.push('list');
      return { studies: [], outcome: { status: 'ok' } };
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ mode: 'hosted' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )));

    render(<StudyList />);

    await waitFor(() => expect(storageMock.getAllStudies).toHaveBeenCalled());
    expect(calls).toEqual(['reconcile', 'list']);
    expect(await screen.findByText('Pending study changes were reconciled successfully.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Load Sample' })).toHaveLength(2);
    expect(screen.queryByText(/load demo data/i)).not.toBeInTheDocument();
  });

  it('surfaces a create 202 as repair-pending and does not navigate as completed', async () => {
    const config = makeStudyConfig({ id: 'server-study', name: 'Pending Study' });
    const study = makeStoredStudy({ id: 'server-study', config });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/auth') {
        return new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/config/status') {
        return new Response(JSON.stringify({ mode: 'hosted', aiTransport: 'direct', hasAnthropicKey: true, hasGeminiKey: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/studies') {
        return new Response(JSON.stringify({
          study,
          message: 'Study saved; platform reconciliation is pending.',
          reconciliationPending: true,
          operationId: 'create:server-study',
        }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');

    render(<StudySetup />);
    await waitFor(() => expect(screen.queryByText(/Checking configured AI providers/i)).not.toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('e.g., AI Adoption in Healthcare'), {
      target: { value: 'Pending Study' },
    });
    fireEvent.change(screen.getByPlaceholderText('What are you trying to understand?'), {
      target: { value: 'How should recovery work?' },
    });

    const save = await screen.findByRole('button', { name: 'Save Study' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    expect(await screen.findByText('Study saved; repair pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repair pending' })).toBeInTheDocument();
    expect(storeMock.state.setStudyConfig).toHaveBeenCalledWith(study.config);
    expect(router.push).not.toHaveBeenCalledWith('/studies/server-study');
  });

  it('keeps a study visible when deletion is awaiting reconciliation', async () => {
    const config = makeStudyConfig({ id: 'study-delete', name: 'Pending Delete Study' });
    storageMock.getAllStudies.mockResolvedValue({
      studies: [makeStoredStudy({ id: 'study-delete', config })],
      outcome: { status: 'ok' },
    });
    storageMock.deleteStudy.mockResolvedValue({
      success: false,
      pending: true,
      operationId: 'delete:study-delete',
      error: 'Study deletion is awaiting reconciliation.',
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ mode: 'standalone' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )));

    render(<StudyList />);

    expect(await screen.findByText('Pending Delete Study')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open actions for Pending Delete Study' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Study deletion is awaiting reconciliation.')).toBeInTheDocument();
    expect(screen.getByText('Pending Delete Study')).toBeInTheDocument();
  });
});
