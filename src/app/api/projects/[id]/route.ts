import { NextResponse } from 'next/server';
import { withProjects, projectNameBody, projectOutcomeResponse, invalidProjectRequest, emptyProjectBody } from '@/lib/projects/http';
import { isProjectId } from '@/lib/projects/validation';
export const dynamic = 'force-dynamic';
const ROUTE = '/api/projects/[id]';
type Params = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Params) {
  return withProjects(ROUTE, true, async store => {
    const { id } = await params;
    if (!isProjectId(id)) return invalidProjectRequest();
    const body = await projectNameBody(request);
    if (body instanceof NextResponse) return body;
    return projectOutcomeResponse(await store.rename({ projectId: id, ...body }), ROUTE);
  });
}
export async function DELETE(request: Request, { params }: Params) {
  return withProjects(ROUTE, true, async store => {
    const { id } = await params;
    if (!isProjectId(id)) return invalidProjectRequest();
    const refused = await emptyProjectBody(request);
    if (refused) return refused;
    return projectOutcomeResponse(await store.delete({ projectId: id }), ROUTE);
  });
}
