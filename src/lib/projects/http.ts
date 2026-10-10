import { NextResponse } from 'next/server';
import { isHostedMode } from '../mode';
import { getHostedResearcherIdentity, getRequestContext } from '../researcherContext';
import { configurationRequiredResponse } from '../researcherAccess';
import { deploymentNotReadyResponse } from '../runtime/readinessGate';
import { RESEARCHER_WORKSPACE_HELD_COPY, workspaceHeldResponse } from '../canonicalStudy';
import { readBoundedBytes, readBoundedJsonObject } from '../requestBody';
import { logRequestFailure } from '../requestLog';
import type { ProjectsStorePort, ProjectOutcome } from './types';
import { closed, normalizeProjectName } from './validation';

export function projectJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
export function invalidProjectRequest() { return projectJson({ error: 'Invalid project request.' }, 400); }
export async function withProjects(route: string, write: boolean, action: (store: ProjectsStorePort) => Promise<NextResponse>): Promise<NextResponse> {
  let response: NextResponse;
  try {
    response = await (async () => {
      const notReady = deploymentNotReadyResponse(route);
      if (notReady) return notReady;
      if (isHostedMode()) {
        const identity = await getHostedResearcherIdentity();
        if (!identity.authorized || !identity.researcherId) return projectJson({ error: 'Unauthorized' }, 401);
        return projectJson({ error: 'Projects are available only in standalone workspaces.', code: 'PROJECTS_STANDALONE_ONLY', retryable: false }, 501);
      }
      const access = await getRequestContext();
      const setup = configurationRequiredResponse(access);
      if (setup) return setup;
      if (!access.authorized || !access.context) return projectJson({ error: 'Unauthorized' }, 401);
      const readiness = await access.context.store.readiness();
      if (readiness.status === 'held') return projectOutcomeResponse(readiness, route);
      if (readiness.status !== 'ready') return projectOutcomeResponse({ status: 'unavailable' }, route);
      if (write && readiness.maintenance !== 'open') return projectOutcomeResponse({ status: 'held', reason: 'maintenance' }, route);
      return action(access.context.store.projects);
    })();
  } catch (error) {
    logRequestFailure({ event: 'route.failure', route, status: 500 }, error);
    response = projectJson({ error: 'Project operation failed.' }, 500);
  }
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
export function projectOutcomeResponse(outcome: ProjectOutcome, route: string): NextResponse {
  switch (outcome.status) {
    case 'ok': return projectJson({ projects: outcome.projects, memberships: outcome.memberships, studyIds: outcome.studyIds });
    case 'found': return projectJson({ project: outcome.project, studyIds: outcome.studyIds });
    case 'created': case 'updated': return projectJson({ project: outcome.project });
    case 'deleted': return projectJson({ deleted: true });
    case 'assigned': return projectJson({ studyId: outcome.studyId, projectId: outcome.projectId });
    case 'held': return workspaceHeldResponse({ route, reason: outcome.reason, ...RESEARCHER_WORKSPACE_HELD_COPY });
    case 'not-found': return projectJson({ error: 'Project not found.', code: 'PROJECT_NOT_FOUND' }, 404);
    case 'study-not-found': return projectJson({ error: 'Study not found.', code: 'STUDY_NOT_FOUND' }, 404);
    case 'persist-guard': return projectJson({ error: 'Study deletion is pending.', code: 'STUDY_PERSIST_PENDING' }, 409);
    case 'too-large': return projectJson({ error: 'Project collection is too large.', code: 'PROJECT_COLLECTION_TOO_LARGE' }, 413);
    case 'quota': return projectJson({ error: 'Project limit reached.', code: 'PROJECT_LIMIT_REACHED' }, 409);
    case 'conflict': return projectJson({ error: 'Project ID conflict.', code: 'PROJECT_ID_CONFLICT' }, 409);
    case 'unavailable': case 'ambiguous': return projectJson({ retryable: true, reason: outcome.status }, 503);
  }
}
export async function projectBody(request: Request) {
  return readBoundedJsonObject(request, 128 * 1024);
}
export async function projectNameBody(request: Request): Promise<{ name: string } | NextResponse> {
  const parsed = await projectBody(request);
  if (!parsed.ok) return projectJson({ error: 'Invalid project request.' }, parsed.status);
  const name = normalizeProjectName(parsed.value.name);
  return closed(parsed.value, ['name']) && name !== null ? { name } : invalidProjectRequest();
}
export async function emptyProjectBody(request: Request): Promise<NextResponse | null> {
  const raw = await readBoundedBytes(request, 1024);
  if (!raw.ok) return projectJson({ error: 'Invalid project request.' }, raw.status);
  return raw.bytes.byteLength === 0 ? null : invalidProjectRequest();
}
