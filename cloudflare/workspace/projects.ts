// Standalone organization records. Transactions never mutate studies or participant authority.
import type { Project, ProjectsStorePort, ProjectOutcome } from '../../src/lib/projects/types';
import { MAX_PROJECTS, MAX_PROJECT_STUDIES } from '../../src/lib/projects/types';
import { closed, isProject, isProjectId, isStudyId, normalizeProjectName } from '../../src/lib/projects/validation';
import { bumpMutationSeq, gate, type WorkspaceContext } from './context';
import { decodeStudyRow, isFenced, readStudyRow } from './studies';

type Row = { id: string; name: string; created_at: number; updated_at: number };
function decode(row: Row): Project {
  const project = { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
  if (!isProject(project)) throw new Error('Invalid project record');
  return project;
}
function project(ws: WorkspaceContext, id: string): Project | null {
  const rows = ws.sql.exec<Row>('SELECT * FROM projects WHERE id = ?', id).toArray();
  return rows[0] ? decode(rows[0]) : null;
}
function roster(ws: WorkspaceContext) {
  if (ws.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM studies').one().n > MAX_PROJECT_STUDIES
    || ws.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM study_projects').one().n > MAX_PROJECT_STUDIES) return null;
  const studies = ws.sql.exec<{ id: string }>('SELECT id FROM studies ORDER BY created_at DESC, id ASC').toArray().map(r => r.id);
  const members = ws.sql.exec<{ study_id: string; project_id: string }>('SELECT study_id, project_id FROM study_projects ORDER BY study_id').toArray();
  if (!studies.every(isStudyId) || members.some(m => !isStudyId(m.study_id) || !isProjectId(m.project_id)
    || !studies.includes(m.study_id) || !project(ws, m.project_id))) throw new Error('Invalid membership');
  return { studyIds: studies, memberships: members.map(m => ({ studyId: m.study_id, projectId: m.project_id })) };
}
function run(ws: WorkspaceContext, write: boolean, action: () => ProjectOutcome): ProjectOutcome {
  try {
    return ws.storage.transactionSync(() => {
      const checked = gate(ws, write ? 'researcher-mutation' : 'read');
      if (!checked.ok) return { status: 'held', reason: checked.reason };
      return action();
    });
  } catch {
    // transactionSync rolls back every SQL statement on throw.
    return { status: 'unavailable' };
  }
}
export function createProjectsStore(ws: WorkspaceContext): ProjectsStorePort {
  return {
    async list() {
      return run(ws, false, () => {
        if (ws.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM projects').one().n > MAX_PROJECTS) return { status: 'too-large' };
        const snapshot = roster(ws);
        if (!snapshot) return { status: 'too-large' };
        return { status: 'ok', projects: ws.sql.exec<Row>('SELECT * FROM projects ORDER BY created_at DESC, id ASC').toArray().map(decode), ...snapshot };
      }) as Awaited<ReturnType<ProjectsStorePort['list']>>;
    },
    async read(input) {
      return run(ws, false, () => {
        if (!closed(input, ['projectId']) || !isProjectId(input.projectId)) return { status: 'unavailable' };
        const found = project(ws, input.projectId);
        if (!found) return { status: 'not-found' };
        const snapshot = roster(ws);
        if (!snapshot) return { status: 'too-large' };
        const selected = new Set(snapshot.memberships.filter(m => m.projectId === input.projectId).map(m => m.studyId));
        return { status: 'found', project: found, studyIds: snapshot.studyIds.filter(id => selected.has(id)) };
      }) as Awaited<ReturnType<ProjectsStorePort['read']>>;
    },
    async create(input) {
      const now = Date.now(), id = crypto.randomUUID();
      return run(ws, true, () => {
        const name = normalizeProjectName(input?.name);
        if (!closed(input, ['name']) || name === null) return { status: 'unavailable' };
        if (ws.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM projects').one().n >= MAX_PROJECTS) return { status: 'quota' };
        if (project(ws, id)) return { status: 'conflict' };
        ws.sql.exec('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', id, name, now, now);
        bumpMutationSeq(ws.sql, now);
        return { status: 'created', project: { id, name, createdAt: now, updatedAt: now } };
      }) as Awaited<ReturnType<ProjectsStorePort['create']>>;
    },
    async rename(input) {
      return run(ws, true, () => {
        const name = normalizeProjectName(input?.name);
        if (!closed(input, ['projectId', 'name']) || !isProjectId(input.projectId) || name === null) return { status: 'unavailable' };
        const found = project(ws, input.projectId);
        if (!found) return { status: 'not-found' };
        if (found.name !== name) {
          found.name = name; found.updatedAt = Math.max(found.updatedAt, Date.now());
          ws.sql.exec('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', name, found.updatedAt, found.id);
          bumpMutationSeq(ws.sql, found.updatedAt);
        }
        return { status: 'updated', project: found };
      }) as Awaited<ReturnType<ProjectsStorePort['rename']>>;
    },
    async delete(input) {
      return run(ws, true, () => {
        if (!closed(input, ['projectId']) || !isProjectId(input.projectId)) return { status: 'unavailable' };
        if (!project(ws, input.projectId)) return { status: 'deleted' };
        const snapshot = roster(ws);
        if (!snapshot) return { status: 'too-large' };
        const now = Date.now();
        if (snapshot.memberships.some(m => m.projectId === input.projectId && isFenced(ws, 'study', m.studyId, now))) return { status: 'persist-guard' };
        ws.sql.exec('DELETE FROM study_projects WHERE project_id = ?', input.projectId);
        ws.sql.exec('DELETE FROM projects WHERE id = ?', input.projectId);
        bumpMutationSeq(ws.sql, now);
        return { status: 'deleted' };
      }) as Awaited<ReturnType<ProjectsStorePort['delete']>>;
    },
    async assignStudy(input) {
      return run(ws, true, () => {
        if (!closed(input, ['studyId', 'projectId']) || !isStudyId(input.studyId)
          || (input.projectId !== null && !isProjectId(input.projectId))) return { status: 'unavailable' };
        const now = Date.now();
        if (isFenced(ws, 'study', input.studyId, now)) return { status: 'persist-guard' };
        const row = readStudyRow(ws, input.studyId);
        if (!row) return { status: 'study-not-found' };
        if (!decodeStudyRow(row)) return { status: 'unavailable' };
        if (input.projectId !== null && !project(ws, input.projectId)) return { status: 'not-found' };
        const current = ws.sql.exec<{ project_id: string }>('SELECT project_id FROM study_projects WHERE study_id = ?', input.studyId).toArray()[0]?.project_id ?? null;
        if (current !== null && (!isProjectId(current) || !project(ws, current))) return { status: 'unavailable' };
        if (current !== input.projectId) {
          if (input.projectId === null) ws.sql.exec('DELETE FROM study_projects WHERE study_id = ?', input.studyId);
          else ws.sql.exec('INSERT INTO study_projects (study_id, project_id) VALUES (?, ?) ON CONFLICT(study_id) DO UPDATE SET project_id = excluded.project_id', input.studyId, input.projectId);
          bumpMutationSeq(ws.sql, now);
        }
        return { status: 'assigned', studyId: input.studyId, projectId: input.projectId };
      }) as Awaited<ReturnType<ProjectsStorePort['assignStudy']>>;
    },
  };
}
