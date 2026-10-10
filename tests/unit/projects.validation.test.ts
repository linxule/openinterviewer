import { describe, expect, it } from 'vitest';
import { isProject, isProjectId, isProjectOutcome, isStudyId, normalizeProjectName } from '@/lib/projects/validation';
const id = '00000000-0000-4000-8000-000000000001';
const project = { id, name: 'Étude 研究 🙂', createdAt: 1, updatedAt: 2 };
describe('project domain validation', () => {
  it('normalizes names, preserves Unicode, and bounds UTF-16 code units', () => {
    expect(normalizeProjectName('  研究 🙂  ')).toBe('研究 🙂');
    expect(normalizeProjectName('🙂'.repeat(100))).not.toBeNull();
    expect(normalizeProjectName('🙂'.repeat(101))).toBeNull();
  });
  it.each(['', '   ', '\nName', 'Name\t', '\u007f', '\u0085', 'a'.repeat(201), null, 3])('rejects invalid names: %j', value => {
    expect(normalizeProjectName(value)).toBeNull();
  });
  it('requires closed records, canonical UUIDs and safe monotonic timestamps', () => {
    expect(isProject(project)).toBe(true);
    for (const change of [{ name: ' spaced ' }, { extra: true }, { createdAt: -1 }, { updatedAt: 0 },
      { updatedAt: Number.MAX_SAFE_INTEGER + 1 }, { id: '../other' }]) expect(isProject({ ...project, ...change })).toBe(false);
    expect(isProjectId(id)).toBe(true);
    expect(isStudyId('demo-study-1')).toBe(true);
    expect(isStudyId('x'.repeat(129))).toBe(false);
  });
  it('rejects malformed, duplicate and dangling snapshot members and forged operation identities', () => {
    const list = { status: 'ok', projects: [project], studyIds: ['s'], memberships: [{ studyId: 's', projectId: id }] };
    expect(isProjectOutcome(list, 'list')).toBe(true);
    for (const change of [{ studyIds: [] }, { projects: [] }, { memberships: [...list.memberships, ...list.memberships] },
      { studyIds: ['s', 's'] }, { extra: true }]) expect(isProjectOutcome({ ...list, ...change }, 'list')).toBe(false);
    expect(isProjectOutcome({ status: 'updated', project }, 'rename', { projectId: id, name: project.name })).toBe(true);
    expect(isProjectOutcome({ status: 'updated', project }, 'rename', { projectId: crypto.randomUUID(), name: project.name })).toBe(false);
    expect(isProjectOutcome({ status: 'held', reason: 'unknown' }, 'list')).toBe(false);
    expect(isProjectOutcome({ status: 'deleted' }, 'create')).toBe(false);
  });
});
