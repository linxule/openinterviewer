import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const storageMock = vi.hoisted(() => ({
  getStudy: vi.fn(),
  getStudyInterviews: vi.fn(),
}));
vi.mock('@/services/storageService', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/services/storageService');
  return {
    ...actual,
    getStudy: storageMock.getStudy,
    getStudyInterviews: storageMock.getStudyInterviews,
  };
});

import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import StudyDetail from '@/components/StudyDetail';

function renderStudyDetail(studyId: string) {
  return render(
    <BreadcrumbProvider>
      <StudyDetail studyId={studyId} />
    </BreadcrumbProvider>
  );
}

function repeat<T>(value: T, count: number): T[] {
  return Array.from({ length: count }, () => value);
}

/**
 * The reminder's whole contract (O8, Ruling 1): fires only at 2+ distinct
 * RECORDED conducting models, on both the Overview and Interviews tabs, and
 * never infers a conducting model from the study's own current config.
 */

const CONFIG_MODEL = 'gemini-4.0-flash-should-never-appear';

beforeEach(() => {
  vi.clearAllMocks();
  const config = makeStudyConfig({
    id: 'study-conducting', name: 'Conducting Models Study', aiProvider: 'gemini', aiModel: CONFIG_MODEL,
  });
  storageMock.getStudy.mockResolvedValue(
    makeStoredStudy({ id: 'study-conducting', config, revision: 1, interviewCount: 7 })
  );
});

describe('StudyDetail — ConductingModelsNotice', () => {
  it('fires with two recorded models, counts descending, on the Interviews tab', async () => {
    storageMock.getStudyInterviews.mockResolvedValue([
      ...repeat(0, 4).map((_, i) => makeStoredInterview({
        id: `interview-a${i}`, studyId: 'study-conducting',
        conductedByProvider: 'gemini', conductedByModel: 'gemini-3.7-flash',
      })),
      ...repeat(0, 3).map((_, i) => makeStoredInterview({
        id: `interview-b${i}`, studyId: 'study-conducting',
        conductedByProvider: 'gemini', conductedByModel: 'gemini-3.8-flash',
      })),
    ]);

    renderStudyDetail('study-conducting');
    await screen.findByRole('heading', { name: 'Conducting Models Study' });
    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));

    expect(await screen.findByText('Conducted with 2 models')).toBeInTheDocument();
    expect(screen.getByText('gemini-3.7-flash ×4 · gemini-3.8-flash ×3')).toBeInTheDocument();
  });

  it('fires on the Overview tab too, with identical copy (Ruling 1)', async () => {
    storageMock.getStudyInterviews.mockResolvedValue([
      ...repeat(0, 4).map((_, i) => makeStoredInterview({
        id: `interview-a${i}`, studyId: 'study-conducting',
        conductedByProvider: 'gemini', conductedByModel: 'gemini-3.7-flash',
      })),
      ...repeat(0, 3).map((_, i) => makeStoredInterview({
        id: `interview-b${i}`, studyId: 'study-conducting',
        conductedByProvider: 'gemini', conductedByModel: 'gemini-3.8-flash',
      })),
    ]);

    renderStudyDetail('study-conducting');
    await screen.findByRole('heading', { name: 'Conducting Models Study' });

    expect(await screen.findByText('Conducted with 2 models')).toBeInTheDocument();
    expect(screen.getByText('gemini-3.7-flash ×4 · gemini-3.8-flash ×3')).toBeInTheDocument();
  });

  it('renders no notice when the study spans exactly one model', async () => {
    storageMock.getStudyInterviews.mockResolvedValue(
      repeat(0, 7).map((_, i) => makeStoredInterview({
        id: `interview-${i}`, studyId: 'study-conducting',
        conductedByProvider: 'gemini', conductedByModel: 'gemini-3.7-flash',
      })),
    );

    renderStudyDetail('study-conducting');
    await screen.findByRole('heading', { name: 'Conducting Models Study' });

    expect(screen.queryByText(/^Conducted with/)).not.toBeInTheDocument();
  });

  it('renders no notice for seven legacy interviews with no conductedByModel, and never infers the study config model', async () => {
    storageMock.getStudyInterviews.mockResolvedValue(
      repeat(0, 7).map((_, i) => makeStoredInterview({ id: `interview-${i}`, studyId: 'study-conducting' })),
    );

    const { container } = renderStudyDetail('study-conducting');
    await screen.findByRole('heading', { name: 'Conducting Models Study' });
    fireEvent.click(screen.getByRole('tab', { name: 'Interviews' }));

    expect(screen.queryByText(/^Conducted with/)).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(CONFIG_MODEL);
  });

  it('ends the counts line with "not recorded ×1" for a mixed study with one legacy interview', async () => {
    storageMock.getStudyInterviews.mockResolvedValue([
      makeStoredInterview({
        id: 'interview-a', studyId: 'study-conducting',
        conductedByProvider: 'gemini', conductedByModel: 'gemini-3.7-flash',
      }),
      makeStoredInterview({
        id: 'interview-b', studyId: 'study-conducting',
        conductedByProvider: 'claude', conductedByModel: 'claude-sonnet-5',
      }),
      makeStoredInterview({ id: 'interview-c', studyId: 'study-conducting' }),
    ]);

    renderStudyDetail('study-conducting');
    await screen.findByRole('heading', { name: 'Conducting Models Study' });

    const counts = await screen.findByText(/not recorded ×1$/);
    expect(counts).toBeInTheDocument();
  });

  it('renders with a neutral tone, never the error border class', async () => {
    storageMock.getStudyInterviews.mockResolvedValue([
      makeStoredInterview({
        id: 'interview-a', studyId: 'study-conducting',
        conductedByProvider: 'gemini', conductedByModel: 'gemini-3.7-flash',
      }),
      makeStoredInterview({
        id: 'interview-b', studyId: 'study-conducting',
        conductedByProvider: 'claude', conductedByModel: 'claude-sonnet-5',
      }),
    ]);

    renderStudyDetail('study-conducting');
    const eyebrow = await screen.findByText('Conducted with 2 models');
    const notice = eyebrow.closest('div');
    expect(notice?.className).not.toMatch(/border-error/);
  });
});
