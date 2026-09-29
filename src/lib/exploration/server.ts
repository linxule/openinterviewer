import { NextResponse } from 'next/server';
import { getAuthorizedResearcherStudyContext, type ResearcherContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import { mapReadinessHold, mapStudyLoad, RESEARCHER_MUTATION_STATES } from '@/lib/ownedStudies';
import { isDurableWorkspaceStore } from '@/lib/storage/types';
import type { StoredStudy } from '@/types';
import type { ExplorationAnswer, ExplorationStorePort } from './types';
import { EXPLORATION_ATTEMPT_DEADLINE_MS } from './types';

export const EXPLORATION_ROUTE = '/api/studies/[id]/exploration';
export const explorationJson = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});

export async function explorationContext(studyId: string, mutation = false): Promise<
  { ok: true; context: ResearcherContext; study: StoredStudy; notebook: ExplorationStorePort | undefined }
  | { ok: false; response: NextResponse }
> {
  const notReady = deploymentNotReadyResponse(EXPLORATION_ROUTE);
  if (notReady) return { ok: false, response: notReady };
  const gated = await getAuthorizedResearcherStudyContext(studyId, 'read');
  const denied = configurationRequiredResponse(gated);
  if (denied) return { ok: false, response: denied };
  if (!gated.authorized || !gated.context) return { ok: false, response: explorationJson({
    error: gated.error || 'Unauthorized', retryable: gated.retryable,
    ...(gated.code ? { code: gated.code } : {}),
  }, gated.statusCode ?? 401) };
  const context = gated.context;
  if (mutation && isDurableWorkspaceStore(context.store)) {
    const readiness = await context.store.readiness();
    if (readiness.status === 'unavailable') return { ok: false, response: explorationJson({ error: 'Study storage is temporarily unavailable.', retryable: true }, 503) };
    const held = mapReadinessHold(readiness, RESEARCHER_MUTATION_STATES, EXPLORATION_ROUTE);
    if (held) return { ok: false, response: held };
  }
  const loaded = mapStudyLoad(await context.store.getStudy(studyId));
  if (!loaded.ok) return { ok: false, response: explorationJson(loaded.body, loaded.status) };
  return { ok: true, context, study: loaded.study, notebook: context.store.exploration };
}

/** A crashed request becomes uncertain, never automatically another paid call. */
export async function recoverInterruptedAnswer(notebook: ExplorationStorePort, answer: ExplorationAnswer): Promise<ExplorationAnswer> {
  if (answer.status !== 'running' || Date.now() - answer.createdAt <= EXPLORATION_ATTEMPT_DEADLINE_MS + 30_000) return answer;
  const recovered = await notebook.fail({ studyId: answer.studyId, answerId: answer.id,
    requestFingerprint: answer.requestFingerprint, status: 'recovery-required',
    failureKind: 'request-interrupted', now: Date.now() });
  return recovered.status === 'saved' ? recovered.answer : answer;
}
