import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignStudyProject, createProject, deleteProject, exportProjectTranscriptsChecked, listProjects, renameProject } from '@/services/projectService';
import { hasProjectTranscriptsCompleteMarker } from '@/lib/export/projectTranscriptsMarkdown';
const id = '11111111-1111-4111-8111-111111111111';
const project = { id, name: 'One', createdAt: 1, updatedAt: 1 };
const inner = '<!-- openinterviewer-export complete: 1 interview -->';
const complete = `# Project\n<!-- openinterviewer-project-export studies: 1 -->\n<!-- openinterviewer-project-export study: study-a; 1 interviews -->\n${inner}\n<!-- openinterviewer-project-export complete: 1 studies; 1 interviews -->\n`;
afterEach(() => vi.unstubAllGlobals());
describe('project client', () => {
  it('accepts only a complete project marker with matching manifest counts', async () => {
    for (const text of [complete.slice(0, complete.indexOf(inner) + inner.length), complete.slice(0, -10), complete.replace('1 studies; 1', '2 studies; 1'), complete.replace('study-a; 1', 'study-a; 2'), `> ${complete.split('\n').at(-2)}`]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text)));
      expect((await exportProjectTranscriptsChecked(id)).status).toBe('error');
      expect(hasProjectTranscriptsCompleteMarker(text)).toBe(false);
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(complete, { headers: { 'Content-Disposition': 'attachment; filename="project.md"' } })));
    const result = await exportProjectTranscriptsChecked(id);
    expect(result.status).toBe('ok'); if (result.status === 'ok') expect(result.value.filename).toBe('project.md');
  });
  it('does not confuse hosted refusal or invalid snapshots with an empty project list', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ code: 'PROJECTS_STANDALONE_ONLY' }, { status: 501 })).mockResolvedValueOnce(Response.json({ projects: [], memberships: [] }));
    vi.stubGlobal('fetch', fetch);
    expect(await listProjects()).toMatchObject({ status: 'error', code: 'PROJECTS_STANDALONE_ONLY' });
    expect((await listProjects()).status).toBe('error');
  });
  it('uses bounded explicit writes without create receipts or automatic retries', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ project })).mockResolvedValueOnce(Response.json({ project }))
      .mockResolvedValueOnce(Response.json({ studyId: 'study-a', projectId: id })).mockResolvedValueOnce(Response.json({ studyId: 'study-a', projectId: null }))
      .mockResolvedValueOnce(Response.json({ deleted: true })).mockRejectedValueOnce(new Error('lost reply'));
    vi.stubGlobal('fetch', fetch);
    expect((await createProject('One')).status).toBe('ok'); expect((await renameProject(id, 'One')).status).toBe('ok');
    expect((await assignStudyProject('study-a', id)).status).toBe('ok'); expect((await assignStudyProject('study-a', null)).status).toBe('ok');
    expect((await deleteProject(id)).status).toBe('ok'); expect(await createProject('One')).toMatchObject({ status: 'error', ambiguous: true });
    expect(fetch).toHaveBeenCalledTimes(6); expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Idempotency-Key');
  });
});
