import { explorationContext, explorationJson, recoverInterruptedAnswer } from '@/lib/exploration/server';
import { isExplorationId } from '@/lib/exploration/validation';

export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; answerId: string }> }) {
  const { id, answerId } = await params;
  if (!isExplorationId(answerId)) return explorationJson({ error: 'Invalid saved question.' }, 400);
  const gated = await explorationContext(id);
  if (!gated.ok) return gated.response;
  if (!gated.notebook) return explorationJson({ error: 'Saved exploration is unavailable.', retryable: true }, 503);
  const loaded = await gated.notebook.get({ studyId: id, answerId });
  if (loaded.status !== 'found') return explorationJson({ error: 'The saved question could not be read.', retryable: loaded.status === 'unavailable' }, loaded.status === 'unavailable' ? 503 : 404);
  return explorationJson({ answer: await recoverInterruptedAnswer(gated.notebook, loaded.answer) });
}
