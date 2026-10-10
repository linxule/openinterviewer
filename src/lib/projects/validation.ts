import { MAX_PROJECTS, MAX_PROJECT_STUDIES, type Project, type ProjectOutcome } from './types';

export function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
export function isStudyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value);
}
export function normalizeProjectName(value: unknown): string | null {
  // Reject controls before trimming so leading newlines are not silently accepted.
  // Lone UTF-16 surrogates cannot be stored as UTF-8 (Redis readers reject them), so they are refused here.
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 200 ? name : null;
}
export function isProject(value: unknown): value is Project {
  return closed(value, ['id', 'name', 'createdAt', 'updatedAt']) && isProjectId(value.id)
    && typeof value.name === 'string' && normalizeProjectName(value.name) === value.name
    && typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && typeof value.updatedAt === 'number' && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt;
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PROJECT_STUDIES
    && value.every(isStudyId) && new Set(value).size === value.length;
}
const HOLDS = ['maintenance', 'schema-unsupported', 'workspace-identity-mismatch', 'recovery-epoch-mismatch', 'workspace-uninitialized', 'workspace-unconfigured'];
const FAILURES: Record<string, string[]> = {
  list: ['too-large', 'unavailable'], read: ['not-found', 'too-large', 'unavailable'],
  create: ['quota', 'conflict', 'unavailable', 'ambiguous'],
  rename: ['not-found', 'unavailable', 'ambiguous'],
  delete: ['persist-guard', 'too-large', 'unavailable', 'ambiguous'],
  assignStudy: ['not-found', 'study-not-found', 'persist-guard', 'unavailable', 'ambiguous'],
};
/** Closed, method-specific wire validation; uncertain writes never become success. */
export function isProjectOutcome(value: unknown, method: string, input?: { projectId?: string | null; studyId?: string; name?: string }): value is ProjectOutcome {
  if (!value || typeof value !== 'object' || !('status' in value)) return false;
  const v = value as Record<string, unknown>;
  if (v.status === 'held') return closed(v, ['status', 'reason']) && HOLDS.includes(v.reason as string);
  if (typeof v.status !== 'string') return false;
  if (FAILURES[method]?.includes(v.status)) return closed(v, ['status']);
  if (method === 'list' && v.status === 'ok') {
    if (!closed(v, ['status', 'projects', 'memberships', 'studyIds']) || !ids(v.studyIds)
      || !Array.isArray(v.projects) || v.projects.length > MAX_PROJECTS || !v.projects.every(isProject)
      || new Set(v.projects.map(p => p.id)).size !== v.projects.length || !Array.isArray(v.memberships)
      || v.memberships.length > MAX_PROJECT_STUDIES) return false;
    const projects = new Set(v.projects.map(p => p.id)), studies = new Set(v.studyIds);
    return v.memberships.every(m => closed(m, ['studyId', 'projectId']) && studies.has(m.studyId as string) && projects.has(m.projectId as string))
      && new Set(v.memberships.map(m => m.studyId)).size === v.memberships.length;
  }
  if (method === 'read' && v.status === 'found') return closed(v, ['status', 'project', 'studyIds'])
    && isProject(v.project) && v.project.id === input?.projectId && ids(v.studyIds);
  if ((method === 'create' && v.status === 'created') || (method === 'rename' && v.status === 'updated')) {
    return closed(v, ['status', 'project']) && isProject(v.project)
      && (method === 'create' || v.project.id === input?.projectId) && v.project.name === normalizeProjectName(input?.name);
  }
  if (method === 'delete' && v.status === 'deleted') return closed(v, ['status']);
  return method === 'assignStudy' && v.status === 'assigned' && closed(v, ['status', 'studyId', 'projectId'])
    && isStudyId(v.studyId) && v.studyId === input?.studyId && v.projectId === input?.projectId
    && (v.projectId === null || isProjectId(v.projectId));
}
