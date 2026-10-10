import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { workspaceStub } from './helpers';
import { candidateStudy, createStudyInput, mutationSeq, setMaintenance, sql } from './fixtures';
import { resetWorkspace } from './jobFixtures';

async function project() {
  const outcome = await workspaceStub().createProject({ name: '  Étude 🙂  ' });
  if (outcome.status !== 'created') throw new Error('create failed');
  return outcome.project;
}
async function study() {
  const candidate = candidateStudy();
  const created = await workspaceStub().createStudy(await createStudyInput(candidate));
  if (created.status !== 'created') throw new Error('create failed');
  return created.study;
}
beforeEach(resetWorkspace);
describe('projects on SQLite', () => {
  it('mutates sequence exactly once per effective change, and never study columns or alarms', async () => {
    const p = await project(), s = await study();
    const before = await sql('SELECT * FROM studies WHERE id = ?', s.id);
    const seq = await mutationSeq();
    const alarm = await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.getAlarm());
    expect((await workspaceStub().assignStudyProject({ studyId: s.id, projectId: p.id })).status).toBe('assigned');
    expect(await mutationSeq()).toBe(seq + 1);
    await workspaceStub().assignStudyProject({ studyId: s.id, projectId: p.id });
    await workspaceStub().renameProject({ projectId: p.id, name: p.name });
    expect(await mutationSeq()).toBe(seq + 1);
    await workspaceStub().renameProject({ projectId: p.id, name: 'Changed' });
    expect(await mutationSeq()).toBe(seq + 2);
    await workspaceStub().assignStudyProject({ studyId: s.id, projectId: null });
    expect(await mutationSeq()).toBe(seq + 3);
    await workspaceStub().deleteProject({ projectId: p.id });
    await workspaceStub().deleteProject({ projectId: p.id });
    expect(await mutationSeq()).toBe(seq + 4);
    expect(await sql('SELECT * FROM studies WHERE id = ?', s.id)).toEqual(before);
    expect(await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.getAlarm())).toBe(alarm);
  });
  it('rolls back membership, project and mutation sequence when a later delete statement fails', async () => {
    const p = await project(), s = await study();
    await workspaceStub().assignStudyProject({ studyId: s.id, projectId: p.id });
    const seq = await mutationSeq();
    await sql("CREATE TRIGGER project_delete_fail BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'synthetic cut'); END");
    try {
      expect(await workspaceStub().deleteProject({ projectId: p.id })).toEqual({ status: 'unavailable' });
      expect(await workspaceStub().readProject({ projectId: p.id })).toEqual({ status: 'found', project: p, studyIds: [s.id] });
      expect(await mutationSeq()).toBe(seq);
    } finally { await sql('DROP TRIGGER project_delete_fail'); }
  });
  it('rejects fenced no-op assignment and preflights every project member before deletion', async () => {
    const p = await project(), s = await study(), other = await study();
    for (const item of [s, other]) await workspaceStub().assignStudyProject({ studyId: item.id, projectId: p.id });
    await sql("INSERT INTO deletion_fences (kind, target_id, deleted_at, expires_at, sample_fixture) VALUES ('study', ?, ?, ?, 0)", s.id, Date.now(), Date.now() + 60_000);
    expect(await workspaceStub().assignStudyProject({ studyId: s.id, projectId: p.id })).toEqual({ status: 'persist-guard' });
    expect(await workspaceStub().deleteProject({ projectId: p.id })).toEqual({ status: 'persist-guard' });
    expect(await sql('SELECT * FROM study_projects')).toHaveLength(2);
  });
  it.each(['draining', 'frozen', 'recovery'] as const)('serves reads but refuses mutations while %s', async state => {
    const p = await project();
    await setMaintenance(state);
    expect((await workspaceStub().listProjects()).status).toBe('ok');
    for (const action of [() => workspaceStub().createProject({ name: 'X' }),
      () => workspaceStub().renameProject({ projectId: p.id, name: 'X' }),
      () => workspaceStub().deleteProject({ projectId: p.id }),
      () => workspaceStub().assignStudyProject({ studyId: 's', projectId: p.id })]) {
      expect(await action()).toEqual({ status: 'held', reason: 'maintenance' });
    }
  });
  it('retains identity and recovery-epoch holds', async () => {
    const p = await project();
    await sql("UPDATE workspace_meta SET activated_epoch = ?", 'ep_' + 'f'.repeat(32));
    expect((await workspaceStub().listProjects()).status).toBe('ok');
    expect(await workspaceStub().deleteProject({ projectId: p.id })).toEqual({ status: 'held', reason: 'recovery-epoch-mismatch' });
    await sql("UPDATE workspace_meta SET workspace_id = ?", 'ws_' + 'f'.repeat(32));
    try {
      expect(await workspaceStub().listProjects()).toEqual({ status: 'held', reason: 'workspace-identity-mismatch' });
    } finally {
      const { testEnv } = await import('./helpers');
      await sql('UPDATE workspace_meta SET workspace_id = ?', testEnv.WORKSPACE_ID);
    }
  });
  it('SQL constraints and domain validation refuse malformed metadata or dangling membership', async () => {
    const p = await project();
    await expect(sql("UPDATE projects SET name = '' WHERE id = ?", p.id)).rejects.toThrow();
    await sql('UPDATE projects SET updated_at = ? WHERE id = ?', Number.MAX_SAFE_INTEGER + 1, p.id);
    expect(await workspaceStub().readProject({ projectId: p.id })).toEqual({ status: 'unavailable' });
    await sql('UPDATE projects SET updated_at = ? WHERE id = ?', p.updatedAt, p.id);
    await sql('INSERT INTO study_projects (study_id, project_id) VALUES (?, ?)', 'missing-study', p.id);
    expect(await workspaceStub().listProjects()).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().deleteProject({ projectId: p.id })).toEqual({ status: 'unavailable' });
  });
  it('bounds collections and create quota without truncation; individual unassignment remains available', async () => {
    const p = await project(), s = await study();
    await workspaceStub().assignStudyProject({ studyId: s.id, projectId: p.id });
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      for (let i = 0; i < 1000; i++) state.storage.sql.exec('INSERT INTO projects VALUES (?, ?, 0, 0)', crypto.randomUUID(), 'Synthetic');
    });
    expect(await workspaceStub().listProjects()).toEqual({ status: 'too-large' });
    expect(await workspaceStub().createProject({ name: 'Overflow' })).toEqual({ status: 'quota' });
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      for (let i = 0; i < 1000; i++) state.storage.sql.exec('INSERT INTO studies (id, config_json, revision, created_at, updated_at, interview_count, is_locked, sample_fixture) VALUES (?, ?, 1, 0, 0, 0, 0, 0)', 'bound-' + i, JSON.stringify({ id: 'bound-' + i }));
    });
    expect(await workspaceStub().readProject({ projectId: p.id })).toEqual({ status: 'too-large' });
    expect(await workspaceStub().deleteProject({ projectId: p.id })).toEqual({ status: 'too-large' });
    expect((await workspaceStub().assignStudyProject({ studyId: s.id, projectId: null })).status).toBe('assigned');
  });
});
