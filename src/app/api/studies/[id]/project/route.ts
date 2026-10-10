import { withProjects, projectBody, projectJson, projectOutcomeResponse, invalidProjectRequest } from '@/lib/projects/http';
import { closed, isProjectId, isStudyId } from '@/lib/projects/validation';
export const dynamic = 'force-dynamic';
const ROUTE = '/api/studies/[id]/project';
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withProjects(ROUTE, true, async store => {
    const { id } = await params;
    if (!isStudyId(id)) return invalidProjectRequest();
    const parsed = await projectBody(request);
    if (!parsed.ok) return projectJson({ error: 'Invalid project request.' }, parsed.status);
    const body = parsed.value;
    if (!closed(body, ['projectId']) || (body.projectId !== null && !isProjectId(body.projectId))) return invalidProjectRequest();
    return projectOutcomeResponse(await store.assignStudy({ studyId: id, projectId: body.projectId as string | null }), ROUTE);
  });
}
