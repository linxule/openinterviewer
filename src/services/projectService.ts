import type { Project, StudyProjectMembership } from '@/lib/projects/types';
import { isProjectOutcome } from '@/lib/projects/validation';
import { hasProjectTranscriptsCompleteMarker } from '@/lib/export/projectTranscriptsMarkdown';
import { downloadFilename } from './storageService';

export type ProjectSnapshot = { projects: Project[]; memberships: StudyProjectMembership[]; studyIds: string[] };
export type ProjectResult<T> = { status: 'ok'; value: T } | { status: 'error'; error: string; code?: string; ambiguous: boolean };
async function request<T>(url: string, method: string, operation: string, success: string, input?: { name?: string; projectId?: string | null; studyId?: string }, body?: unknown): Promise<ProjectResult<T>> {
  const write = method !== 'GET';
  try {
    const response = await fetch(url, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) return { status: 'error', error: typeof data.error === 'string' ? data.error : 'Project operation is temporarily unavailable. Refresh before trying again.', code: data.code, ambiguous: write && response.status >= 500 };
    if (!isProjectOutcome({ ...data, status: success }, operation, input)) throw new Error('Invalid project response');
    return { status: 'ok', value: data as T };
  } catch {
    return { status: 'error', error: 'Project operation is temporarily unavailable. Refresh before trying again.', ambiguous: write };
  }
}
export const listProjects = () => request<ProjectSnapshot>('/api/projects', 'GET', 'list', 'ok');
export const createProject = (name: string) => request<{ project: Project }>('/api/projects', 'POST', 'create', 'created', { name }, { name });
export const renameProject = (projectId: string, name: string) => request<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId)}`, 'PATCH', 'rename', 'updated', { projectId, name }, { name });
// DELETE's HTTP representation differs from its store outcome.
export async function deleteProject(projectId: string): Promise<ProjectResult<{ deleted: true }>> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
    const data = await response.json();
    if (response.ok && data.deleted === true) return { status: 'ok', value: { deleted: true } };
    return { status: 'error', error: data.error || 'Project deletion could not be confirmed. Refresh before trying again.', code: data.code, ambiguous: response.status >= 500 || response.ok };
  } catch { return { status: 'error', error: 'Project deletion could not be confirmed. Refresh before trying again.', ambiguous: true }; }
}
export const assignStudyProject = (studyId: string, projectId: string | null) => request<{ studyId: string; projectId: string | null }>(`/api/studies/${encodeURIComponent(studyId)}/project`, 'PUT', 'assignStudy', 'assigned', { studyId, projectId }, { projectId });

export async function exportProjectTranscriptsChecked(projectId: string): Promise<ProjectResult<{ file: Blob; filename: string }>> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/export`);
    if (!response.ok) {
      const data = await response.json();
      return { status: 'error', error: data.error || 'Project export is temporarily unavailable.', code: data.code, ambiguous: false };
    }
    const text = await response.text();
    if (!hasProjectTranscriptsCompleteMarker(text)) return { status: 'error', error: 'The project export did not complete. Try the export again.', ambiguous: false };
    return { status: 'ok', value: { file: new Blob([text], { type: 'text/markdown;charset=utf-8' }), filename: downloadFilename(response.headers.get('Content-Disposition'), `project-${projectId}-transcripts.md`) } };
  } catch { return { status: 'error', error: 'The project export did not complete. Try the export again.', ambiguous: false }; }
}
