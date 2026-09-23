// Queued-synthesis helpers shared by the Queue consumer and the WorkspaceStore
// attachment check (JOB-02/08/09). The synthesis ceiling itself is the shared
// MAX_ATTACHED_SYNTHESIS_BYTES contract in analysisProtocol. Pure: no
// bindings, no I/O, no provider modules, so the Durable Object can import it.

import type { AIProviderType } from '../../src/types';

/** Native secret names; read from the Worker env only at execution. */
export const PROVIDER_KEY_NAMES: Readonly<Record<AIProviderType, string>> = {
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
