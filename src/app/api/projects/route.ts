import { NextResponse } from 'next/server';
import { withProjects, projectNameBody, projectOutcomeResponse } from '@/lib/projects/http';
export const dynamic = 'force-dynamic';
const ROUTE = '/api/projects';
export async function GET() {
  return withProjects(ROUTE, false, async store => projectOutcomeResponse(await store.list(), ROUTE));
}
export async function POST(request: Request) {
  return withProjects(ROUTE, true, async store => {
    const body = await projectNameBody(request);
    if (body instanceof NextResponse) return body;
    return projectOutcomeResponse(await store.create(body), ROUTE);
  });
}
