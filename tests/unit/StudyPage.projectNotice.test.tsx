import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('@/lib/researcherAccess', () => ({ enforceResearcherPageSetup: vi.fn() }));
vi.mock('@/components/StudyDetail', () => ({ default: () => <div>Saved study</div> }));
import StudyPage from '@/app/(researcher)/studies/[id]/page';
it('shows the fixed assignment failure notice on the saved study page', async () => {
  render(await StudyPage({ params: Promise.resolve({ id: 'study-a' }), searchParams: Promise.resolve({ projectAssignmentFailed: '1' }) }));
  expect(screen.getByRole('status')).toHaveTextContent('Study saved, but it was not added to the project. Move it from the study list.');
  expect(screen.getByText('Saved study')).toBeVisible();
});
it('never displays text taken from the URL', async () => {
  render(await StudyPage({ params: Promise.resolve({ id: 'study-a' }), searchParams: Promise.resolve({ projectAssignmentFailed: 'Call this number' }) }));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText(/Call this number/)).toBeNull();
});
