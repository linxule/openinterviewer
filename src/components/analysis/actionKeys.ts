import type { AnalysisStatusResult } from '@/services/analysisApi';

/** One intentional "run analysis" action: its key and the body it was sent with. */
export type AnalysisAction = { key: string; expectedGeneration: number };

/**
 * Request identity for durable analysis (API-03, UI-CF-03). A key belongs to
 * one intentional action and is reused, with the same body, for every retry
 * of that action whose outcome was not confirmed. A fresh key is minted only
 * once the confirmed generation has moved on (the action was answered or the
 * state was refreshed), so a double press or an uncertain retry can never
 * become a second paid attempt.
 */
export class AnalysisActionKeys {
  private readonly actions = new Map<string, AnalysisAction>();

  actionFor(interviewId: string, expectedGeneration: number): AnalysisAction {
    const retained = this.actions.get(interviewId);
    if (retained && retained.expectedGeneration === expectedGeneration) return retained;
    const action = { key: crypto.randomUUID(), expectedGeneration };
    this.actions.set(interviewId, action);
    return action;
  }

  /** Forget the action once the server has answered it definitively. */
  settle(interviewId: string, result: AnalysisStatusResult): void {
    if (result.ok || result.kind === 'state-changed' || result.kind === 'key-conflict' || result.kind === 'not-found') {
      this.actions.delete(interviewId);
    }
  }

  clear(): void {
    this.actions.clear();
  }
}
