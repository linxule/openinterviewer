import { readBoundedJsonObject } from '@/lib/requestBody';
import { loadStudyDataset } from '@/lib/exploration/dataset';
import { isDatasetSelection } from '@/lib/exploration/validation';
import { explorationContext, explorationJson } from '@/lib/exploration/server';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';
import type { DatasetSelection } from '@/lib/exploration/types';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ id: string }> };

async function describe(request: Request, params: Params, selection: DatasetSelection) {
  try {
    const { id } = await params.params;
    const gated = await explorationContext(id);
    if (!gated.ok) return gated.response;
    const loaded = await loadStudyDataset({ studyId: id, selection, store: gated.context.store });
    if (loaded.status === 'invalid-selection') return explorationJson({ error: 'The selected interviews could not be resolved.', code: 'INVALID_DATASET_SELECTION' }, 400);
    if (loaded.status === 'too-large') return explorationJson({ error: 'This study exceeds the interactive dataset limit. Use a scoped export for offline analysis.', maximum: loaded.maximum }, 413);
    if (loaded.status === 'unavailable') return explorationJson({ error: 'Interview storage is temporarily unavailable.', retryable: true }, 503);
    return explorationJson({ dataset: loaded.description });
  } catch (error) {
    logRequestFailure({ event: 'route.failure', route: '/api/studies/[id]/dataset', method: request.method, status: 500, requestId: createRequestId(request.headers.get('x-request-id')) }, error);
    return explorationJson({ error: 'The dataset could not be read.', retryable: true }, 500);
  }
}

export async function GET(request: Request, params: Params) { return describe(request, params, {}); }
export async function POST(request: Request, params: Params) {
  const body = await readBoundedJsonObject(request, 16_384);
  if (!body.ok) return explorationJson({ error: 'Invalid dataset selection.' }, body.status);
  if (Object.keys(body.value).some(key => key !== 'selection') || !isDatasetSelection(body.value.selection)) return explorationJson({ error: 'Invalid dataset selection.', code: 'INVALID_DATASET_SELECTION' }, 400);
  return describe(request, params, body.value.selection);
}
