import { withProjects, invalidProjectRequest, projectOutcomeResponse, projectJson } from '@/lib/projects/http';
import { isProjectId } from '@/lib/projects/validation';
import { isDurableWorkspaceStore } from '@/lib/storage/types';
import { prepareStudyTranscriptsSource, exportMutationRefusal, exportChangedResponse, exportUnavailableResponse } from '@/lib/export/studyTranscriptsSource';
import { createProjectTranscriptsStream } from '@/lib/export/projectTranscriptsMarkdown';
import { transcriptsContentDisposition, TRANSCRIPTS_MARKDOWN_CONTENT_TYPE } from '@/lib/export/transcriptsMarkdown';

export const dynamic = 'force-dynamic';
const ROUTE = '/api/projects/[id]/export';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withProjects(ROUTE, false, async (projects, store) => {
    const { id } = await params;
    if (!isProjectId(id)) return invalidProjectRequest();
    const roster = await projects.read({ projectId: id });
    if (roster.status !== 'found') return projectOutcomeResponse(roster, ROUTE);
    const members: Array<{ id: string; createdAt: number }> = [];
    let total = 0;
    // Counts come from authoritative backend reads, never browser study summaries.
    // Preflight snapshots are not retained: each source captures anew when consumed.
    for (const studyId of roster.studyIds) {
      const refused = await exportMutationRefusal(store, [studyId]);
      if (refused) return refused;
      const study = await store.getStudy(studyId);
      if (study.status === 'not-found') return exportChangedResponse();
      if (study.status !== 'found') return exportUnavailableResponse();
      members.push({ id: studyId, createdAt: study.study.createdAt });
      const counted = isDurableWorkspaceStore(store)
        ? await store.beginExport({ studyId, maximum: 500 })
        : await store.listInterviews({ scope: 'study', studyId, maximum: 500 });
      if (counted.status === 'too-large') total = 501;
      else if (counted.status === 'ok') total += 'count' in counted ? counted.count : counted.items.length;
      else if (counted.status !== 'empty') return exportUnavailableResponse();
      if (total > 500) return projectJson({ error: 'This project exceeds 500 interviews. Export individual studies instead.', code: 'PROJECT_EXPORT_TOO_LARGE' }, 413);
    }
    if (total === 0) return projectJson({ error: 'This project has no saved interviews to export.', code: 'NO_TRANSCRIPTS' }, 404);
    members.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const verify = async (): Promise<Response | null> => {
      const current = await projects.read({ projectId: id });
      if (current.status === 'not-found') return exportChangedResponse();
      if (current.status !== 'found') return projectOutcomeResponse(current, ROUTE);
      if (current.project.id !== roster.project.id || current.project.name !== roster.project.name
        || current.studyIds.length !== roster.studyIds.length || current.studyIds.some(member => !roster.studyIds.includes(member))) return exportChangedResponse();
      const refusal = await exportMutationRefusal(store, roster.studyIds);
      if (refusal) return refusal;
      for (const studyId of roster.studyIds) {
        const study = await store.getStudy(studyId);
        if (study.status === 'not-found') return exportChangedResponse();
        if (study.status !== 'found') return exportUnavailableResponse();
      }
      return null;
    };
    const refusal = await verify();
    if (refusal) return refusal;
    const body = createProjectTranscriptsStream({
      project: roster.project, studyIds: members.map(member => member.id),
      prepare: async (studyId, remaining) => {
        const source = await prepareStudyTranscriptsSource(store, studyId, Math.max(1, remaining), true);
        if (source instanceof Response) throw new Error('Project study export unavailable');
        return source;
      },
      beforeFinish: async () => { if (await verify()) throw new Error('Project export changed'); },
    });
    return new Response(body, { headers: {
      'Content-Type': TRANSCRIPTS_MARKDOWN_CONTENT_TYPE,
      'Content-Disposition': transcriptsContentDisposition(roster.project.name, id),
      'Cache-Control': 'no-store',
    } });
  });
}
