import { getInterviewProvider } from '@/lib/providers';
import { providerKeysFromContext } from '@/lib/researcherContext';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { researcherAiBudgetResponse } from '@/lib/researcherAiBudget';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';
import { ProviderFailure, ProviderTimeoutError } from '@/lib/providerErrors';
import { validateProvenance } from '@/lib/synthesisProvenance';
import { commitmentCovers } from '@/lib/providerCommitment';
import { currentProviderTransport, participantDisclosures, uncoveredCount, researcherTransportNotDisclosedResponse } from '@/lib/transportDisclosure';
import { getResearcherArtifactSigningSecret } from '@/lib/auth';
import { assertExplorationCorpus, datasetDigest, loadStudyDataset, normalizeDatasetSelection } from '@/lib/exploration/dataset';
import { resolveExplorationPayload } from '@/lib/exploration/evidence';
import { isDatasetSelection, isExplorationAnswer, isExplorationId, isExplorationQuestion, isProviderExecution } from '@/lib/exploration/validation';
import { signExplorationReceipt } from '@/lib/exploration/receipt';
import { explorationContext, explorationJson, recoverInterruptedAnswer, EXPLORATION_ROUTE } from '@/lib/exploration/server';
import { EXPLORATION_ATTEMPT_DEADLINE_MS, MAX_EXPLORATION_ANSWERS, type CompleteExplorationInput, type ExplorationAnswer } from '@/lib/exploration/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;
type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, params: Params) {
  try {
    const { id } = await params.params;
    const gated = await explorationContext(id);
    if (!gated.ok) return gated.response;
    if (!gated.notebook) return explorationJson({ error: 'Saved exploration is unavailable.', retryable: true }, 503);
    const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;
    if (cursor !== undefined && !/^[0-9]{1,16}:[A-Za-z0-9_-]{1,120}$/.test(cursor)) return explorationJson({ error: 'Invalid notebook cursor.' }, 400);
    const loaded = await gated.notebook.list({ studyId: id, maximum: MAX_EXPLORATION_ANSWERS, pageSize: 25, ...(cursor ? { cursor } : {}) });
    if (loaded.status !== 'ok') return explorationJson({ error: 'Saved exploration could not be read.', retryable: true }, 503);
    // Sequential bounded storage mutations, never provider calls.
    const answers: ExplorationAnswer[] = [];
    for (const answer of loaded.answers) answers.push(await recoverInterruptedAnswer(gated.notebook, answer));
    return explorationJson({ answers, nextCursor: loaded.nextCursor ?? null });
  } catch (error) {
    logRequestFailure({ event: 'route.failure', route: EXPLORATION_ROUTE, method: 'GET', status: 500, requestId: createRequestId(request.headers.get('x-request-id')) }, error);
    return explorationJson({ error: 'Saved exploration could not be read.', retryable: true }, 500);
  }
}

export async function POST(request: Request, params: Params) {
  try {
    const body = await readBoundedJsonObject(request, 16_384);
    if (!body.ok) return explorationJson({ error: 'Invalid study question.' }, body.status);
    const input = body.value;
    const key = request.headers.get('Idempotency-Key');
    if (Object.keys(input).some(name => !['question', 'selection', 'parentAnswerId'].includes(name))
      || !isExplorationQuestion(input.question) || !isDatasetSelection(input.selection)
      || (input.parentAnswerId !== undefined && !isExplorationId(input.parentAnswerId))
      || !key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
      return explorationJson({ error: 'Provide a bounded question, dataset selection and unique request key.', code: 'INVALID_EXPLORATION_REQUEST' }, 400);
    }
    const { id } = await params.params;
    const gated = await explorationContext(id, true);
    if (!gated.ok) return gated.response;
    const { context, study, notebook } = gated;
    if (!notebook) return explorationJson({ error: 'Saved exploration is unavailable.', retryable: true }, 503);
    const question = input.question.trim();
    const selection = normalizeDatasetSelection(input.selection);
    const parentAnswerId = input.parentAnswerId;
    const requestFingerprint = await datasetDigest({ question, selection, parentAnswerId: parentAnswerId ?? null, promptVersion: 1 });
    const keyDigest = await datasetDigest({ studyId: id, researcherId: context.researcherId, key });
    if (notebook.lookup) {
      const existing = await notebook.lookup({ studyId: id, keyDigest, requestFingerprint });
      if (existing.status === 'found') return explorationJson({ answer: await recoverInterruptedAnswer(notebook, existing.answer) });
      if (existing.status === 'key-reuse') return explorationJson({ error: 'This request key was already used for a different question or selection.', code: 'EXPLORATION_KEY_REUSE' }, 409);
      if (existing.status === 'unavailable') return explorationJson({ error: 'The previous attempt could not be checked. Keep the same request key.', retryable: true }, 503);
    }
    let previousQuestions: string[] | undefined;
    if (parentAnswerId) {
      const parent = await notebook.get({ studyId: id, answerId: parentAnswerId });
      if (parent.status === 'unavailable') return explorationJson({ error: 'The previous question could not be read.', retryable: true }, 503);
      if (parent.status !== 'found' || parent.answer.status !== 'complete') return explorationJson({ error: 'The previous question is not a saved completed answer.' }, 409);
      previousQuestions = [parent.answer.question];
    }
    const dataset = await loadStudyDataset({ studyId: id, selection, store: context.store });
    if (dataset.status === 'invalid-selection') return explorationJson({ error: 'The selected interviews could not be resolved.', code: 'INVALID_DATASET_SELECTION' }, 400);
    if (dataset.status === 'too-large') return explorationJson({ error: 'This study exceeds the interactive dataset limit. Export it for offline analysis.' }, 413);
    if (dataset.status === 'unavailable') return explorationJson({ error: 'Interview storage is temporarily unavailable.', retryable: true }, 503);
    const corpus = assertExplorationCorpus(dataset.interviews);
    if (corpus.status === 'empty') return explorationJson({ error: 'Select at least one saved interview.', code: 'EMPTY_DATASET' }, 400);
    if (corpus.status === 'too-large') return explorationJson({ error: 'The selected dataset is too large for one exploration request. Narrow the selection; no interviews have been sampled.', code: 'EXPLORATION_CORPUS_TOO_LARGE', ...corpus }, 413);
    const transport = currentProviderTransport(context, study.config.aiProvider);
    if (transport.applies && !transport.ok) return explorationJson({ error: 'The AI transport is not configured.', code: 'PROVIDER_NOT_CONFIGURED' }, 409);
    if (transport.applies && transport.ok) {
      const uncovered = uncoveredCount(participantDisclosures(dataset.interviews), transport.transport);
      if (uncovered) return researcherTransportNotDisclosedResponse(uncovered);
    }
    const incompatible = dataset.interviews.filter(record => !commitmentCovers(record, study.config.aiProvider, study.config.aiModel)).length;
    if (incompatible) return explorationJson({ error: 'Some selected interviews require their original provider and model. Narrow the selection or restore that configuration.', code: 'PROVIDER_COMMITMENT_MISMATCH', incompatibleInterviewCount: incompatible }, 409);
    // Resolve all non-paid prerequisites before admitting a durable attempt.
    let provider;
    try {
      provider = getInterviewProvider(study.config, providerKeysFromContext(context));
      getResearcherArtifactSigningSecret();
    } catch {
      return explorationJson({ error: 'The provider or result-recovery signing configuration is unavailable. No model request was made.', code: 'PROVIDER_NOT_CONFIGURED' }, 409);
    }
    const now = Date.now();
    const answer: ExplorationAnswer = { id: crypto.randomUUID(), studyId: id, question,
      ...(parentAnswerId ? { parentAnswerId } : {}), scope: dataset.description.manifest,
      createdAt: now, updatedAt: now, status: 'running', requestFingerprint, promptVersion: 1 };
    const reserved = await notebook.reserve({ answer, expectedStudyRevision: study.revision, keyDigest });
    if (reserved.status === 'replay') return explorationJson({ answer: await recoverInterruptedAnswer(notebook, reserved.answer) });
    if (reserved.status !== 'created') {
      const status = reserved.status === 'quota' ? 429 : reserved.status === 'study-not-found' ? 404 : ['key-reuse', 'revision-stale'].includes(reserved.status) ? 409 : 503;
      return explorationJson({ error: reserved.status === 'key-reuse' ? 'This request key was already used for a different question or selection.' : reserved.status === 'quota' ? 'This study has reached its saved-question limit. Export the notebook before starting a new study.' : 'The question could not be admitted. Refresh the study before trying again.', code: `EXPLORATION_${reserved.status.toUpperCase().replaceAll('-', '_')}`, retryable: status === 503 }, status);
    }
    const admitted = reserved.answer;
    const budget = await hostedAiRateLimitResponse(request, 'exploration', { researcherId: context.researcherId })
      ?? await researcherAiBudgetResponse(request, 'exploration', context.store, EXPLORATION_ROUTE);
    if (budget) {
      const failureKind = budget.status === 429 ? 'budget-limited' : 'budget-unavailable';
      const failed = await notebook.fail({ studyId: id, answerId: admitted.id, requestFingerprint, status: 'failed', failureKind, now: Date.now() });
      return explorationJson({ answer: failed.status === 'saved' ? failed.answer : { ...admitted, updatedAt: Date.now(), status: 'failed', failureKind } });
    }
    let completion: CompleteExplorationInput;
    let completed: ExplorationAnswer;
    try {
      const generated = await provider.exploreStudy({ question, studyConfig: study.config, interviews: dataset.interviews, ...(previousQuestions ? { previousQuestions } : {}) }, { kind: 'exploration', deadlineMs: EXPLORATION_ATTEMPT_DEADLINE_MS });
      const execution = generated.execution;
      if (!isProviderExecution(execution) || !validateProvenance({ aiProvider: execution.provider, aiModel: execution.model, requestedAiModel: execution.requestedModel,
        ...(execution.routedProvider ? { routedProvider: execution.routedProvider } : {}), ...(execution.aiTransport ? { aiTransport: execution.aiTransport } : {}) })) throw new ProviderFailure('invalid-response', 'Invalid exploration provenance');
      completion = { studyId: id, answerId: admitted.id, requestFingerprint,
        result: resolveExplorationPayload(generated.value, dataset.interviews), execution, now: Date.now() };
      completed = { ...admitted, updatedAt: completion.now, status: 'complete', result: completion.result, execution };
      if (!isExplorationAnswer(completed)) throw new ProviderFailure('invalid-response', 'Invalid exploration artifact');
    } catch (error) {
      const uncertain = error instanceof ProviderTimeoutError || !(error instanceof ProviderFailure) || error.kind === 'unavailable';
      const status = uncertain ? 'recovery-required' : 'failed';
      const failureKind = error instanceof ProviderTimeoutError ? 'provider-timeout' : error instanceof ProviderFailure ? `provider-${error.kind}` : 'provider-unavailable';
      const failed = await notebook.fail({ studyId: id, answerId: admitted.id, requestFingerprint, status, failureKind, now: Date.now() });
      return explorationJson({ answer: failed.status === 'saved' ? failed.answer : { ...admitted, updatedAt: Date.now(), status, failureKind } });
    }
    const saved = await notebook.complete(completion).catch(() => ({ status: 'unavailable' as const }));
    if (saved.status === 'saved') return explorationJson({ answer: saved.answer });
    // Never recreate a deleted study or turn a save retry into another paid call.
    const saveReceipt = await signExplorationReceipt(completion, context.researcherId);
    return explorationJson({ answer: completed, unsaved: true, saveReceipt });
  } catch (error) {
    logRequestFailure({ event: 'route.failure', route: EXPLORATION_ROUTE, method: 'POST', status: 500, requestId: createRequestId(request.headers.get('x-request-id')) }, error);
    return explorationJson({ error: 'The question could not be confirmed. Check the same attempt before starting another paid request.', retryable: true }, 500);
  }
}
