import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStudyConfig } from '../fixtures/models';
import { BreadcrumbProvider } from '@/components/shell/breadcrumb';
import InterviewDetail from '@/components/InterviewDetail';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const storage = vi.hoisted(() => ({ getInterview: vi.fn() }));
vi.mock('@/services/storageService', async importOriginal => ({ ...await importOriginal<typeof import('@/services/storageService')>(), ...storage }));
const renderInterview = () => render(<BreadcrumbProvider><InterviewDetail interviewId="profile-record" studyId="study-profile" /></BreadcrumbProvider>);
beforeEach(() => vi.clearAllMocks());

describe('historical participant profile visibility', () => {
  it('shows recorded, vague, refused and missing states using collection-time labels', async () => {
    storage.getInterview.mockResolvedValue(makeStoredInterview({ id: 'profile-record', studyId: 'study-profile', collectionConfig: makeStudyConfig({ profileSchema: ['recorded', 'vague', 'refused', 'missing'].map(id => ({ id, label: `Original ${id}`, extractionHint: id, required: false })) }), participantProfile: { id: 'profile', rawContext: '', timestamp: 100, fields: [{ fieldId: 'recorded', value: 'Designer', status: 'extracted' }, { fieldId: 'vague', value: 'Around thirty', status: 'vague' }, { fieldId: 'refused', value: null, status: 'refused' }] } }));
    renderInterview();
    await screen.findByText('Original recorded');
    expect(screen.getByText('Designer')).toBeInTheDocument();
    expect(screen.getByText('Vague: Around thirty')).toBeInTheDocument();
    expect(screen.getByText('Declined to answer')).toBeInTheDocument();
    expect(screen.getByText('Original missing')).toBeInTheDocument();
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
  });

  it('does not reconstruct a legacy definition from current study labels', async () => {
    storage.getInterview.mockResolvedValue(makeStoredInterview({ id: 'profile-record', studyId: 'study-profile', participantProfile: { id: 'profile', rawContext: '', timestamp: 100, fields: [{ fieldId: 'old-field-id', value: null, status: 'refused' }] } }));
    renderInterview();
    await screen.findByText('old-field-id');
    expect(screen.getByText('Declined to answer')).toBeInTheDocument();
    expect(screen.getByText(/Original profile definitions were not recorded/)).toBeInTheDocument();
    expect(screen.getByText('Original field definition unavailable')).toBeInTheDocument();
  });
});
