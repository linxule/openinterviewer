'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { isPendingStudyStub, StoredInterview, StudyWorkspaceItem } from '@/types';
import {
  readAllInterviews,
  exportAllInterviews,
  getStudyInterviews,
  getAllStudies,
  reconcileStudyOperations,
  ResearcherStorageUnavailableError,
  StudyOperationPendingError,
} from '@/services/storageService';
import { Button, Coordinate, Field, Measure, Notice, Rule } from '@/components/ui';
import { shortInterviewId } from '@/lib/interviewId';
import { useSetTrailingCrumb } from '@/components/shell/breadcrumb';

export default function Dashboard() {
  const router = useRouter();
  const [interviews, setInterviews] = useState<StoredInterview[]>([]);
  const [studies, setStudies] = useState<StudyWorkspaceItem[]>([]);
  const [selectedStudyId, setSelectedStudyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);

  const selectedStudy = selectedStudyId ? studies.find((study) => study.id === selectedStudyId) : null;
  useSetTrailingCrumb(
    selectedStudy && !isPendingStudyStub(selectedStudy) ? selectedStudy.config.name : null
  );

  // Load studies on mount
  useEffect(() => {
    loadStudies();
  }, []);

  // Load interviews when study filter changes.
  useEffect(() => {
    loadInterviews(selectedStudyId);
    // loadInterviews is recreated each render; selectedStudyId is the load key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStudyId]);


  const loadStudies = async () => {
    try {
      const { studies: data, pendingStudies, warning: storageWarning, outcome } = await getAllStudies();
      setStudies(data);
      setWarning(
        outcome.status === 'unavailable'
          ? outcome.error
          : (storageWarning ?? null),
      );
      setOperationPending(
        outcome.status === 'pending'
        || (pendingStudies?.length ?? 0) > 0
        || data.some(isPendingStudyStub),
      );
    } catch (error) {
      console.error('Error loading studies:', error);
    }
  };

  const loadInterviews = async (studyId: string | null) => {
    setLoading(true);
    try {
      const selected = studies.find((study) => study.id === studyId);
      if (selected && isPendingStudyStub(selected)) {
        setOperationPending(true);
        setInterviews([]);
        return;
      }
      if (studyId) {
        setInterviews(await getStudyInterviews(studyId));
        return;
      }
      const outcome = await readAllInterviews();
      if (outcome.status === 'ok') {
        setInterviews(outcome.value.interviews);
        if (outcome.value.pendingStudies.length > 0) setOperationPending(true);
        return;
      }
      if (outcome.status === 'pending') {
        setOperationPending(true);
        setInterviews([]);
        return;
      }
      setInterviews([]);
      setWarning(outcome.error);
    } catch (error) {
      if (error instanceof StudyOperationPendingError) {
        setOperationPending(true);
        setInterviews([]);
      } else if (error instanceof ResearcherStorageUnavailableError) {
        setWarning(error.message);
      } else {
        console.error('Error loading interviews:', error);
      }
    } finally {
      setLoading(false);
    }
  };

  const runReconciliation = async () => {
    setIsReconciling(true);
    const result = await reconcileStudyOperations();
    setIsReconciling(false);
    if (result.success && result.stillPending === 0) setOperationPending(false);
    await loadStudies();
    await loadInterviews(selectedStudyId);
  };

  const handleExportAll = async () => {
    setExporting(true);
    try {
      const blob = await exportAllInterviews();
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `interviews-export-${Date.now()}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      if (error instanceof StudyOperationPendingError) {
        setOperationPending(true);
      } else if (error instanceof ResearcherStorageUnavailableError) {
        setWarning(error.message);
      } else {
        console.error('Error exporting:', error);
      }
    } finally {
      setExporting(false);
    }
  };

  const handleViewInterview = (id: string, studyId: string) => {
    router.push(`/dashboard/interview/${id}?studyId=${encodeURIComponent(studyId)}`);
  };

  const formatDuration = (start: number, end: number) => {
    const minutes = Math.round((end - start) / 1000 / 60);
    return `${minutes} min`;
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleTbodyKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-row-primary]')
    );
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex === -1) return;
    const nextIndex = event.key === 'ArrowDown' ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex < 0 || nextIndex >= buttons.length) return;
    event.preventDefault();
    buttons[nextIndex]?.focus();
  };

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-sans text-[24px] leading-[32px] font-semibold text-ink-900">Interviews</h1>
          <p className="text-[13px] text-ink-500">
            {interviews.length} interview{interviews.length !== 1 ? 's' : ''} collected
          </p>
        </div>
        {interviews.length > 0 && (
          <Button
            type="button"
            variant="primary"
            onClick={() => void handleExportAll()}
            disabled={exporting || operationPending}
          >
            Export All
          </Button>
        )}
      </div>

      <Rule className="my-6" />

      {studies.length > 0 && (
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <Field label="Study" htmlFor="dashboard-study-filter">
            <select
              value={selectedStudyId || ''}
              onChange={(e) => setSelectedStudyId(e.target.value || null)}
            >
              <option value="">All Studies</option>
              {studies.map((study) => (
                <option key={study.id} value={study.id}>
                  {isPendingStudyStub(study)
                    ? `Pending ${study.id.slice(0, 8)}`
                    : `${study.config.name} (${study.interviewCount} interviews)`}
                </option>
              ))}
            </select>
          </Field>
          {selectedStudyId && (
            <button
              type="button"
              onClick={() => setSelectedStudyId(null)}
              className="text-[13px] text-ink-500 hover:text-ink-900"
            >
              Clear filter
            </button>
          )}
        </div>
      )}

      {operationPending && (
        <Notice tone="error" eyebrow="Pending reconciliation" role="status" className="mb-6">
          <p className="mt-1 text-[13px] text-ink-700">A study operation is already in progress.</p>
          <Button
            type="button"
            variant="quiet"
            onClick={() => void runReconciliation()}
            disabled={isReconciling}
            className="mt-2"
          >
            Reconcile
          </Button>
        </Notice>
      )}

      {warning && (
        <Notice tone="error" eyebrow="Workspace" className="mb-6">
          <p className="mt-1 text-[13px] text-ink-700">{warning}</p>
        </Notice>
      )}

      {loading ? (
        <p className="text-[13px] text-ink-500">Loading interviews…</p>
      ) : interviews.length === 0 ? (
        <Measure>
          {operationPending ? (
            <>
              <h2 className="font-sans text-[18px] font-semibold text-ink-900">Study change pending</h2>
              <p className="mt-2 text-[15px] text-ink-700">
                Interview export and collection reads will resume after reconciliation.
              </p>
            </>
          ) : warning ? (
            <>
              <h2 className="font-sans text-[18px] font-semibold text-ink-900">Workspace unavailable</h2>
              <p className="mt-2 text-[15px] text-ink-700">{warning}</p>
            </>
          ) : (
            <>
              <h2 className="font-sans text-[18px] font-semibold text-ink-900">No Interviews Yet</h2>
              <p className="mt-2 text-[15px] text-ink-700">
                Completed interviews will appear here. Share participant links to start collecting data.
              </p>
              <Button type="button" variant="primary" onClick={() => router.push('/setup')} className="mt-4">
                Create Study Link
              </Button>
            </>
          )}
        </Measure>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-ink-300">
                <th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  ID
                </th>
                <th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  Study
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 md:table-cell"
                >
                  Participant
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 sm:table-cell"
                >
                  Started
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 md:table-cell"
                >
                  Duration
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 md:table-cell"
                >
                  Turns
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 lg:table-cell"
                >
                  Model
                </th>
                <th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody onKeyDown={handleTbodyKeyDown}>
              {interviews.map((interview) => {
                const extractedFields = (interview.participantProfile?.fields ?? [])
                  .filter((f) => f.status === 'extracted' && f.value)
                  .slice(0, 3)
                  .map((f) => f.value)
                  .join(' • ');
                return (
                  <tr
                    key={interview.id}
                    className="border-b border-ink-200 hover:bg-paper-1"
                    onClick={() => handleViewInterview(interview.id, interview.studyId)}
                  >
                    <td className="px-3 py-3 align-top text-[13px] text-ink-700">
                      <Coordinate>{shortInterviewId(interview.id)}</Coordinate>
                    </td>
                    <td className="px-3 py-3 align-top text-[13px] text-ink-700">
                      <button
                        type="button"
                        data-row-primary
                        onClick={(event) => {
                          event.stopPropagation();
                          handleViewInterview(interview.id, interview.studyId);
                        }}
                        className="text-left font-sans text-[14px] font-medium text-ink-900 underline-offset-2 hover:text-action hover:underline"
                      >
                        {interview.studyName}
                      </button>
                      {interview.synthesis?.bottomLine && (
                        <p className="line-clamp-1 text-[13px] text-ink-500">{interview.synthesis.bottomLine}</p>
                      )}
                    </td>
                    <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 md:table-cell">
                      {extractedFields || '—'}
                    </td>
                    <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 sm:table-cell">
                      <Coordinate>{formatDate(interview.createdAt)}</Coordinate>
                    </td>
                    <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 md:table-cell">
                      <Coordinate>{formatDuration(interview.createdAt, interview.completedAt)}</Coordinate>
                    </td>
                    <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 md:table-cell">
                      <Coordinate>{interview.transcript.length}</Coordinate>
                    </td>
                    <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 lg:table-cell">
                      <Coordinate>{interview.aiModel ?? '—'}</Coordinate>
                    </td>
                    <td className="px-3 py-3 align-top text-[13px] text-ink-700">
                      <span className={interview.status === 'completed' ? 'text-ink-500' : 'text-ink-900'}>
                        {interview.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
