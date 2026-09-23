// Test-only Worker entry for the Workers Vitest plugin. Never referenced by a
// deployable configuration. It exports the real WorkspaceStore class and the
// real Queue consumer so tests exercise production code against real local
// SQLite, alarms and Queue batches.
export { WorkspaceStore } from '../workspace/WorkspaceStore';

const testEntry = {
  async fetch(): Promise<Response> {
    return new Response('test entry', { status: 404 });
  },
};

export default testEntry;
