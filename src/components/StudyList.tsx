'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { isPendingStudyStub, StudyWorkspaceItem } from '@/types';
import {
  deleteStudy,
  getAllStudies,
  reconcileStudyOperations,
} from '@/services/storageService';
import { listProjects, createProject, renameProject, deleteProject, assignStudyProject, exportProjectTranscriptsChecked, type ProjectSnapshot, type ProjectResult } from '@/services/projectService';
import { normalizeProjectName } from '@/lib/projects/validation';
import { Button, Coordinate, Icon, Measure, Notice, Rule } from '@/components/ui';

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
  const [projectMode, setProjectMode] = useState<'loading' | 'standalone' | 'disabled'>('loading');
  const [projectSnapshot, setProjectSnapshot] = useState<ProjectSnapshot | null>(null);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [movingStudy, setMovingStudy] = useState<string | null>(null);
  const projectTriggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const projectBusyRef = useRef(false);
  const actionsTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const loadStudies = async (withProjects = projectMode === 'standalone') => {
    setLoading(true);
    try {
      const { studies: data, pendingStudies, warning, outcome } = await getAllStudies();
      setStudies(data);
      if (withProjects) {
        const result = await listProjects();
        if (result.status === 'ok' && result.value.studyIds.length === data.length
          && data.every(study => result.value.studyIds.includes(study.id))) {
          setProjectSnapshot(result.value);
        } else {
          setProjectSnapshot(null);
          setProjectNotice('Project grouping could not be loaded or has changed. Refresh to see current grouping. The flat study list is shown below.');
        }
      }
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
      let standalone = false;
      try {
        const response = await fetch('/api/config/mode');
        const data = await response.json();
        hosted = response.ok && data.mode === 'hosted';
        standalone = response.ok && data.mode === 'standalone';
      } catch {
        hosted = false;
      }
      setHostedMode(hosted);
      setProjectMode(standalone ? 'standalone' : 'disabled');
      if (!standalone && !hosted) setProjectNotice('Workspace mode is unavailable. Project controls are unavailable; the flat study list is shown below.');
      if (hosted) {
        await runReconciliation();
      } else {
        await loadStudies(standalone);
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
        await loadStudies();
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

  // Setup resolves the URL's canonical study, including after a reload.
  const handleEdit = (id: string) => {
    setMenuOpenId(null);
    router.push(`/setup?prefill=edit&studyId=${encodeURIComponent(id)}`);
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

  const handleTbodyKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-row-primary]')
    ).filter(button => !button.closest('[hidden]'));
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex === -1) return;
    const nextIndex = event.key === 'ArrowDown' ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex < 0 || nextIndex >= buttons.length) return;
    event.preventDefault();
    buttons[nextIndex]?.focus();
  };

  const runProjectAction = async (action: () => Promise<ProjectResult<unknown>>, focusId?: string) => {
    if (projectBusyRef.current) return;
    projectBusyRef.current = true;
    setProjectBusy(true);
    setProjectNotice(null);
    try {
      const result = await action();
      if (result.status === 'error') setProjectNotice(result.error);
      setProjectMenu(null);
      setMenuOpenId(null);
      setMovingStudy(null);
      await loadStudies(); // Including uncertain writes: never infer success or auto-retry.
    } finally {
      projectBusyRef.current = false;
      setProjectBusy(false);
      if (focusId) requestAnimationFrame(() => (actionsTriggerRefs.current[focusId] ?? projectTriggers.current[focusId])?.focus());
    }
  };
  const nameProject = (id?: string, currentName = '') => {
    const raw = window.prompt(id ? 'Rename project' : 'New project name', currentName);
    if (raw === null) return;
    const name = normalizeProjectName(raw);
    if (!name) { setProjectNotice('Use a project name of 1–200 characters without control characters.'); return; }
    void runProjectAction(() => id ? renameProject(id, name) : createProject(name), id);
  };
  const downloadProject = async (id: string) => {
    await runProjectAction(async () => {
      const result = await exportProjectTranscriptsChecked(id);
      if (result.status === 'ok') {
        const url = URL.createObjectURL(result.value.file);
        const link = document.createElement('a');
        link.href = url; link.download = result.value.filename; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      return result;
    });
  };
  const membershipByStudy = new Map(projectSnapshot?.memberships.map(m => [m.studyId, m.projectId]));
  const groups = projectSnapshot ? [
    ...projectSnapshot.projects.map(project => ({ id: project.id, name: project.name, project,
      studies: studies.filter(study => membershipByStudy.get(study.id) === project.id) })),
    { id: 'ungrouped', name: 'Ungrouped', project: null,
      studies: studies.filter(study => !membershipByStudy.has(study.id)) },
  ] : [{ id: 'flat', name: 'Studies', project: null, studies }];

  return (
    <div onKeyDown={handleTbodyKeyDown}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-sans text-[24px] leading-[32px] font-semibold text-ink-900">My Studies</h1>
          <p className="text-[13px] text-ink-500">
            {studies.length} {studies.length === 1 ? 'study' : 'studies'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {projectMode === 'standalone' && <Button type="button" className="min-h-11" variant="quiet" disabled={projectBusy} onClick={() => nameProject()}>New project</Button>}
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
        <Notice
          tone="error"
          eyebrow={kvWarning.toLowerCase().includes('unavailable') ? 'Workspace unavailable' : 'Storage Not Configured'}
          className="mb-6"
        >
          <p className="mt-1 text-[13px] text-ink-700">{kvWarning}</p>
          {!kvWarning.toLowerCase().includes('unavailable') && (
            <p className="mt-1 text-[13px] text-ink-700">
              See the README for setup instructions using Upstash Redis.
            </p>
          )}
        </Notice>
      )}

      {operationNotice && (
        <Notice tone="error" eyebrow="Pending reconciliation" role="status" className="mb-6">
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
        </Notice>
      )}

      {projectNotice && <Notice tone="error" role="status" className="mb-6">
        <p className="text-[13px]">{projectNotice}</p>
        <Button variant="quiet" disabled={loading || projectBusy} onClick={() => { if (projectMode === 'disabled' && !hostedMode) { window.location.reload(); return; } setProjectNotice(null); void loadStudies(); }}>Refresh</Button>
      </Notice>}

      {sampleMessage && (
        <Notice tone={sampleMessage.type} className="mb-6 flex items-start gap-3">
          <p className="flex-1 text-[13px] text-ink-700">{sampleMessage.text}</p>
          <button
            type="button"
            onClick={() => setSampleMessage(null)}
            aria-label="Dismiss message"
            className="flex min-h-11 min-w-11 items-center justify-center text-ink-500 hover:text-ink-900"
          >
            <Icon name="close" />
          </button>
        </Notice>
      )}

      {loading ? (
        <p className="text-[13px] text-ink-500">Loading studies…</p>
      ) : studies.length === 0 && !projectSnapshot ? (
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
        <div className="space-y-6">{groups.map(group => <section key={group.id} aria-label={group.name}>
          {projectSnapshot && <div className="flex flex-wrap items-center gap-2 border-b border-ink-300">
            <button type="button" className="min-h-11 min-w-11 flex flex-1 items-center gap-2 basis-full sm:basis-auto text-left text-[15px] font-semibold text-ink-900"
              aria-expanded={!collapsed.has(group.id)} aria-controls={`project-section-${group.id}`}
              onClick={event => {
                event.currentTarget.focus();
                setCollapsed(previous => { const next = new Set(previous); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; });
                setMenuOpenId(null); setMovingStudy(null);
              }}>
              <Icon name="chevron" className={collapsed.has(group.id) ? undefined : 'rotate-180'} />
              <span className="break-words min-w-0">{group.name}</span>{' '}
              <Coordinate>{group.studies.length} {group.studies.length === 1 ? 'study' : 'studies'}</Coordinate>
            </button>
            {group.project && <>
              <Button className="min-h-11" variant="quiet" disabled={projectBusy} onClick={() => router.push(`/setup?projectId=${group.id}`)}>+ Study</Button>
              <div className="relative" onKeyDown={event => { if (event.key === 'Escape') { setProjectMenu(null); projectTriggers.current[group.id]?.focus(); } }}>
                <button type="button" className="min-h-11 min-w-11 text-ink-700" aria-label={`Project actions for ${group.name}`}
                  aria-expanded={projectMenu === group.id} ref={el => { projectTriggers.current[group.id] = el; }}
                  onClick={() => setProjectMenu(projectMenu === group.id ? null : group.id)}>···</button>
                {projectMenu === group.id && <div className="absolute right-0 z-20 w-48 rounded-sm border border-ink-300 bg-paper-1 shadow-note">
                  <Button className="min-h-11 w-full justify-start" variant="quiet" disabled={projectBusy} onClick={() => nameProject(group.id, group.name)}>Rename</Button>
                  <Button className="min-h-11 w-full justify-start" variant="quiet" disabled={projectBusy} onClick={() => void downloadProject(group.id)}>Export transcripts</Button>
                  <Button className="min-h-11 w-full justify-start" variant="destructive" disabled={projectBusy} onClick={() => {
                    if (window.confirm('Delete this project? Its studies will move to Ungrouped. No study or interview will be deleted.')) void runProjectAction(() => deleteProject(group.id));
                  }}>Delete project</Button>
                </div>}
              </div>
            </>}
          </div>}
          <div id={`project-section-${group.id}`} hidden={collapsed.has(group.id)}>
          {group.studies.length === 0 ? <p className="py-4 text-[13px] text-ink-500">No studies in this section.</p> : (
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
            <tbody>
              {group.studies.map((study) => {
                const pending = isPendingStudyStub(study);
                const name = pending ? 'Study change pending' : study.config.name;
                const hasCollectedData = !pending && (study.isLocked || study.interviewCount > 0);
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
                        className="min-h-11 min-w-11 text-left font-sans text-[14px] font-medium text-ink-900 underline-offset-2 hover:text-action hover:underline"
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
                      <Coordinate>{pending ? '—' : study.coreQuestionCount}</Coordinate>
                    </td>
                    <td className="px-3 py-3 align-top text-[13px] text-ink-700">
                      {pending ? (
                        <span className="text-error">Reconciliation pending</span>
                      ) : (
                        <span className={hasCollectedData ? 'text-ink-500' : 'text-success'}>
                          {hasCollectedData ? 'Collected data' : 'Editable'}
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
                        className="inline-flex items-center gap-1 min-h-11 min-w-11 text-[13px] text-ink-500 hover:text-ink-900"
                      >
                        Actions
                        <Icon name="chevron" className={menuOpenId === study.id ? 'rotate-180' : undefined} />
                      </button>
                      {menuOpenId === study.id && (
                        <div
                          className="absolute right-0 z-10 mt-1 w-48 rounded-sm border border-ink-300 bg-paper-1 shadow-note"
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              setMovingStudy(null);
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
                            className="block min-h-11 w-full px-3 py-2 text-left text-[13px] text-ink-700 hover:bg-paper-2"
                          >
                            View Details
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (pending) return;
                              void handleEdit(study.id);
                            }}
                            disabled={pending}
                            className="block min-h-11 w-full px-3 py-2 text-left text-[13px] text-ink-700 hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Edit &amp; Generate Link
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMenuOpenId(null);
                              router.push(`/setup?prefill=duplicate&studyId=${encodeURIComponent(study.id)}`);
                            }}
                            disabled={pending}
                            className="block min-h-11 w-full px-3 py-2 text-left text-[13px] text-ink-700 hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Duplicate as test study
                          </button>
                          {projectSnapshot && !pending && <>
                            <Button variant="quiet" className="min-h-11 w-full justify-start" disabled={projectBusy || projectSnapshot.projects.length === 0}
                              onClick={() => setMovingStudy(study.id)}>Move to project…</Button>
                            {movingStudy === study.id && <label className="block px-3 text-[13px] text-ink-700">Destination project
                              <select autoFocus aria-label="Destination project" className="min-h-11 w-full bg-paper-1 border border-ink-300" defaultValue="" disabled={projectBusy}
                                onChange={event => { const target = event.target.value; if (target) { setCollapsed(previous => { const next = new Set(previous); next.delete(target); return next; }); void runProjectAction(() => assignStudyProject(study.id, target), study.id); } }}>
                                <option value="" disabled>Choose a project</option>
                                {projectSnapshot.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                              </select>
                            </label>}
                            <Button variant="quiet" className="min-h-11 w-full justify-start" disabled={projectBusy || !membershipByStudy.has(study.id)}
                              onClick={() => { setCollapsed(previous => { const next = new Set(previous); next.delete('ungrouped'); return next; }); void runProjectAction(() => assignStudyProject(study.id, null), study.id); }}>Ungroup</Button>
                          </>}
                          <button
                            type="button"
                            onClick={() => {
                              if (!pending && study.interviewCount > 0) {
                                setMenuOpenId(null);
                                router.push(`/studies/${encodeURIComponent(study.id)}?tab=settings#danger-zone`);
                              } else {
                                void handleDelete(study.id);
                              }
                            }}
                            disabled={pending || deletingId === study.id}
                            className="block min-h-11 w-full px-3 py-2 text-left text-[13px] text-error hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
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
          )}</div>
        </section>)}</div>
      )}
    </div>
  );
}
