// Test-only Worker entry for the Workers Vitest plugin. Never referenced by a
// deployable configuration. It exports the real WorkspaceStore class and the
// real Queue consumer so tests exercise production code against real local
// SQLite, alarms and Queue batches.
import { handleAnalysisBatch, type ConsumerEnv } from '../analysis/consumer';

export { WorkspaceStore } from '../workspace/WorkspaceStore';

const testEntry = {
  async fetch(): Promise<Response> {
    return new Response('test entry', { status: 404 });
  },
  async queue(batch: MessageBatch<unknown>, env: ConsumerEnv, ctx: ExecutionContext): Promise<void> {
    await handleAnalysisBatch(batch, env, ctx);
  },
};

export default testEntry;
