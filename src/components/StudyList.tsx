'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { isPendingStudyStub, StudyWorkspaceItem } from '@/types';
import {
  deleteStudy,
  getAllStudies,
  reconcileStudyOperations,
} from '@/services/storageService';
import { Button, Coordinate, Label, Measure, Rule } from '@/components/ui';

export default function StudyList() {
  const router = useRouter();
  const [studies, setStudies] = useState<StudyWorkspaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [kvWarning, setKvWarning] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [sampleMessage, setSampleMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [hostedMode, setHostedMode] = useState(false);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);
  const actionsTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const loadStudies = async () => {
    setLoading(true);
    try {
      const { studies: data, pendingStudies, warning, outcome } = await getAllStudies();
      setStudies(data);
      setKvWarning(warning || (outcome.status !== 'ok' ? outcome.error : null));
      if (pendingStudies && pendingStudies.length > 0) {
        setOperationNotice(
          `${pendingStudies.length} study operation(s) are awaiting reconciliation.`,
        );
      }
    } catch (error) {
      console.error('Error loading studies:', error);
    } finally {
      setLoading(false);
    }
  };

  const runReconciliation = async () => {
    setIsReconciling(true);
    const result = await reconcileStudyOperations();
    if (!result.success) {
      setOperationNotice(result.error || 'Study reconciliation is temporarily unavailable.');
    } else if (result.stillPending > 0) {
      setOperationNotice(
        `${result.stillPending} study operation(s) are still inside the safety window. Retry shortly.`
      );
    } else if (result.completed > 0 || result.rolledBack > 0) {
      setOperationNotice('Pending study changes were reconciled successfully.');
    } else {
      setOperationNotice(null);
    }
    setIsReconciling(false);
    await loadStudies();
  };

  useEffect(() => {
    const initializeWorkspace = async () => {
      let hosted = false;
      try {
        const response = await fetch('/api/config/mode');
        const data = await response.json();
        hosted = data.mode === 'hosted';
      } catch {
        hosted = false;
      }
      setHostedMode(hosted);
      if (hosted) {
        await runReconciliation();
      } else {
        await loadStudies();
      }
    };
    void initializeWorkspace();
    // Workspace initialization is intentionally a once-per-mount recovery gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this study? This cannot be undone.')) {
      return;
    }

    setDeletingId(id);
    try {
      const result = await deleteStudy(id);
      if (result.success) {
        setStudies(studies.filter(s => s.id !== id));
      } else if (result.pending) {
        setOperationNotice(result.error || 'Study deletion is awaiting reconciliation.');
      } else {
        alert(result.error || 'Failed to delete study');
      }
    } catch (error) {
      console.error('Error deleting study:', error);
      alert('Failed to delete study');
    } finally {
      setDeletingId(null);
      setMenuOpenId(null);
    }
  };

  const handleLoadSample = async () => {
    setLoadingSample(true);
    setSampleMessage(null);
    try {
      const response = await fetch('/api/demo/seed', { method: 'POST' });
      const data = await response.json();

      if (response.ok) {
        setSampleMessage({
          type: 'success',
          text: `Sample workspace loaded: ${data.data.studiesSeeded} study, ${data.data.interviewsSeeded} interviews`
        });
        await loadStudies(); // Refresh the list
      } else {
        setSampleMessage({ type: 'error', text: data.error || 'Failed to load sample workspace' });
      }
    } catch (error) {
      console.error('Error loading sample workspace:', error);
      setSampleMessage({ type: 'error', text: 'Failed to load sample workspace' });
    } finally {
      setLoadingSample(false);
    }
  };

  const handleClearSample = async () => {
    if (!confirm('Clear the synthetic sample study and interviews from this workspace?')) return;

    setLoadingSample(true);
    setSampleMessage(null);
    try {
      const response = await fetch('/api/demo/seed', { method: 'DELETE' });
      const data = await response.json();

      if (response.ok) {
        setSampleMessage({ type: 'success', text: 'Sample workspace cleared' });
        await loadStudies(); // Refresh the list
      } else {
        setSampleMessage({ type: 'error', text: data.error || 'Failed to clear sample workspace' });
      }
    } catch (error) {
      console.error('Error clearing sample workspace:', error);
      setSampleMessage({ type: 'error', text: 'Failed to clear sample workspace' });
    } finally {
      setLoadingSample(false);
    }
  };

  // Historical records keep their demo-prefixed IDs for compatibility.
  const hasSampleData = studies.some(s => s.id.startsWith('demo-'));

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
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
          <h1 className="font-sans text-[24px] leading-[32px] font-semibold text-ink-900">My Studies</h1>
          <p className="text-[13px] text-ink-500">
            {studies.length} {studies.length === 1 ? 'study' : 'studies'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button type="button" variant="primary" onClick={() => router.push('/setup')}>
            Create Study
          </Button>
          {hasSampleData ? (
            <Button type="button" variant="quiet" onClick={() => void handleClearSample()} disabled={loadingSample}>
              Clear Sample
            </Button>
          ) : (
            <Button
              type="button"
              variant="quiet"
              onClick={() => void handleLoadSample()}
              disabled={loadingSample || !!kvWarning}
            >
              Load Sample
            </Button>
          )}
        </div>
      </div>

      <Rule className="my-6" />

      {kvWarning && (
        <div className="mb-6 border-l-2 border-error bg-paper-2 px-4 py-3">
          <Label>
            {kvWarning.toLowerCase().includes('unavailable') ? 'Workspace unavailable' : 'Storage Not Configured'}
          </Label>
          <p className="mt-1 text-[13px] text-ink-700">{kvWarning}</p>
          {!kvWarning.toLowerCase().includes('unavailable') && (
            <p className="mt-1 text-[13px] text-ink-700">
              See the README for setup instructions using Upstash Redis.
            </p>
          )}
        </div>
      )}

      {operationNotice && (
        <div role="status" className="mb-6 border-l-2 border-error bg-paper-2 px-4 py-3">
          <Label>Pending reconciliation</Label>
          <p className="mt-1 text-[13px] text-ink-700">{operationNotice}</p>
          {hostedMode && (
            <Button
              type="button"
              variant="quiet"
              onClick={() => void runReconciliation()}
              disabled={isReconciling}
              className="mt-2"
            >
              Reconcile
            </Button>
          )}
        </div>
      )}

      {sampleMessage && (
        <div
          className={`mb-6 flex items-start gap-3 border-l-2 bg-paper-2 px-4 py-3 ${
            sampleMessage.type === 'success' ? 'border-success' : 'border-error'
          }`}
        >
          <p className="flex-1 text-[13px] text-ink-700">{sampleMessage.text}</p>
          <button
            type="button"
            onClick={() => setSampleMessage(null)}
            aria-label="Dismiss message"
            className="text-ink-500 hover:text-ink-900"
          >
            ×
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-[13px] text-ink-500">Loading studies…</p>
      ) : studies.length === 0 ? (
        <Measure>
          <h2 className="font-sans text-[18px] font-semibold text-ink-900">
            {kvWarning ? 'Workspace unavailable' : 'No Studies Yet'}
          </h2>
          <p className="mt-2 text-[15px] text-ink-700">
            {kvWarning ? kvWarning : 'Create your first study or load a synthetic sample workspace.'}
          </p>
          <div className="mt-4 flex items-center gap-4">
            {!kvWarning && (
              <Button type="button" variant="primary" onClick={() => router.push('/setup')}>
                Create Study
              </Button>
            )}
            {!kvWarning && (
              <Button type="button" variant="quiet" onClick={() => void handleLoadSample()} disabled={loadingSample}>
                Load Sample
              </Button>
            )}
          </div>
          {!kvWarning && (
            <p className="mt-4 text-[13px] text-ink-500">
              The sample writes one fictional study, 3 completed interviews, and scripted analysis to your configured storage.
            </p>
          )}
        </Measure>
      ) : (
        // `relative` keeps the absolutely-positioned sr-only column header inside
        // this scroll container (see InterviewChat's transcript for the same fix).
        <div className="relative overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-ink-300">
                <th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  Study
                </th>
                <th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  Interviews
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 md:table-cell"
                >
                  Created
                </th>
                <th
                  scope="col"
                  className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500 md:table-cell"
                >
                  Questions
                </th>
                <th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody onKeyDown={handleTbodyKeyDown}>
              {studies.map((study) => {
                const pending = isPendingStudyStub(study);
                const name = pending ? 'Study change pending' : study.config.name;
                return (
                  <tr
                    key={study.id}
                    className="border-b border-ink-200 hover:bg-paper-1"
                    onClick={() => router.push(`/studies/${study.id}`)}
                  >
                    <td className="px-3 py-3 align-top text-[13px] text-ink-700">
                      <button
                        type="button"
                        data-row-primary
                        onClick={(event) => {
                          event.stopPropagation();
                          router.push(`/studies/${study.id}`);
                        }}
                        className="text-left font-sans text-[14px] font-medium text-ink-900 underline-offset-2 hover:text-action hover:underline"
                      >
                        {name}
                      </button>
                      {pending ? (
                        <p className="text-[13px] text-ink-500">Reconciliation pending ({study.phase})</p>
                      ) : study.config.description ? (
                        <p className="line-clamp-1 text-[13px] text-ink-500">{study.config.description}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 align-top text-[13px] text-ink-700">
                      <Coordinate>{pending ? 0 : study.interviewCount}</Coordinate>
                    </td>
                    <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 md:table-cell">
                      <Coordinate>{pending ? '—' : formatDate(study.createdAt)}</Coordinate>
                    </td>
                    <td className="hidden px-3 py-3 align-top text-[13px] text-ink-700 md:table-cell">
                      <Coordinate>{pending ? '—' : study.config.coreQuestions.length}</Coordinate>
                    </td>
                    <td className="px-3 py-3 align-top text-[13px] text-ink-700">
                      {pending ? (
                        <span className="text-error">Reconciliation pending</span>
                      ) : (
                        <span className={study.isLocked ? 'text-ink-500' : 'text-success'}>
                          {study.isLocked ? 'Locked' : 'Editable'}
                        </span>
                      )}
                    </td>
                    <td
                      className="relative px-3 py-3 align-top text-[13px]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        ref={(el) => {
                          actionsTriggerRefs.current[study.id] = el;
                        }}
                        onClick={() => setMenuOpenId(menuOpenId === study.id ? null : study.id)}
                        aria-label={`Open actions for ${name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpenId === study.id}
                        className="text-[13px] text-ink-500 hover:text-ink-900"
                      >
                        Actions
                      </button>
                      {menuOpenId === study.id && (
                        <div
                          className="absolute right-0 z-10 mt-1 w-48 rounded border border-ink-300 bg-paper-1 shadow-note"
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              setMenuOpenId(null);
                              actionsTriggerRefs.current[study.id]?.focus();
                            }
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              router.push(`/studies/${study.id}`);
                              setMenuOpenId(null);
                            }}
                            className="block w-full px-3 py-2 text-left text-[13px] text-ink-700 hover:bg-paper-2"
                          >
                            View Details
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (pending) return;
                              sessionStorage.setItem('prefillStudyConfig', JSON.stringify(study.config));
                              router.push(`/setup?prefill=edit&studyId=${study.id}`);
                              setMenuOpenId(null);
                            }}
                            disabled={pending}
                            className="block w-full px-3 py-2 text-left text-[13px] text-ink-700 hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Edit &amp; Generate Link
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(study.id)}
                            disabled={pending || deletingId === study.id || (!pending && study.interviewCount > 0)}
                            className="block w-full px-3 py-2 text-left text-[13px] text-error hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Delete
                          </button>
                        </div>
                      )}
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
