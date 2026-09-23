// Queue consumer for durable analysis (JOB-06/07/08/09). Provider execution
// happens here, outside the Durable Object and outside any transaction.
// STUB: implemented by the durable-jobs work package.

export type ConsumerEnv = {
  WORKSPACE_STORE: DurableObjectNamespace;
  WORKSPACE_ID?: string;
  WORKSPACE_JURISDICTION?: string;
  ANALYSIS_RECOVERY_EPOCH?: string;
  [key: string]: unknown;
};

export async function handleAnalysisBatch(
  batch: MessageBatch<unknown>,
  env: ConsumerEnv,
  ctx: ExecutionContext,
): Promise<void> {
  void env;
  void ctx;
  // Until implemented, never acknowledge: messages stay on the Queue.
  for (const message of batch.messages) message.retry();
}
