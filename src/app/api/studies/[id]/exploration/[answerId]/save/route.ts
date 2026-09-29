import { readBoundedJsonObject } from '@/lib/requestBody';
import { explorationContext, explorationJson } from '@/lib/exploration/server';
import { verifyExplorationReceipt } from '@/lib/exploration/receipt';
import { isExplorationId } from '@/lib/exploration/validation';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ id: string; answerId: string }> }) {
  const body = await readBoundedJsonObject(request, 310_000);
  if (!body.ok) return explorationJson({ error: 'Invalid saved-result receipt.' }, body.status);
  const { id, answerId } = await params;
  if (!isExplorationId(answerId) || Object.keys(body.value).some(key => key !== 'receipt')) return explorationJson({ error: 'Invalid saved-result receipt.' }, 400);
  const gated = await explorationContext(id, true);
  if (!gated.ok) return gated.response;
  if (!gated.notebook) return explorationJson({ error: 'Saved exploration is unavailable.', retryable: true }, 503);
  const input = await verifyExplorationReceipt(body.value.receipt, { researcherId: gated.context.researcherId, studyId: id, answerId });
  if (!input) return explorationJson({ error: 'This saved-result receipt is invalid or expired. Keep the local export; no provider request was made.' }, 400);
  const saved = await gated.notebook.complete(input).catch(() => ({ status: 'unavailable' as const }));
  if (saved.status !== 'saved') return explorationJson({ error: 'Saving this result could not be confirmed. No provider request was made.', retryable: ['unavailable', 'held'].includes(saved.status) }, ['not-found', 'study-not-found'].includes(saved.status) ? 404 : saved.status === 'conflict' ? 409 : 503);
  return explorationJson({ answer: saved.answer });
}
