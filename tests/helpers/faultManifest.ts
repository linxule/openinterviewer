// Fault harness manifest (Revision 12 §18).
// Every multi-write prefix has fault markers. CI fails if a listed cut has no
// test: crash/adversarial tests register coverage via coverFaultCut, and
// assertFaultCutsCovered() runs at the end of the real-Redis suites.

export const FAULT_CUTS = [
  // Hosted operation registry (Phase 3)
  'R1', 'R2', 'R3', 'R4',
  'recover',
  'resolve',
  'PUB1', 'PUB2', 'PUB3', 'PUB4',
  'PRUNE_DEL', 'PRUNE_ZREM',
  'authority',
  // Account deletion (Phase 5)
  'adel-plan-ops',
  'adel-cursor',
  'adel-local-evict',
  'adel-final-hdel',
  // Standalone/hosted create (Phase 2)
  'S1', 'S2', 'S3', 'S4', 'W1', 'W2',
  // Delete (Phase 2/3)
  'D1', 'D2', 'D3', 'D4',
  // Persist guard (Phase 4)
  'F1', 'F2', 'F3', 'F4', 'F5',
  'persist-guard-cleanup',
  'persist-conflict',
  'persist-cancel',
  'persist-deleted',
  // Transport seams (Phase 6)
  'transport-response-loss',
  'transport-undecodable-after-commit',
] as const;

export type FaultCutId = (typeof FAULT_CUTS)[number];

const covered = new Set<FaultCutId>();

/** A real-Redis or transport-replay test exercised this cut. */
export function coverFaultCut(cutId: FaultCutId): void {
  covered.add(cutId);
}

export function isFaultCutCovered(cutId: FaultCutId): boolean {
  return covered.has(cutId);
}

export function coveredFaultCuts(): FaultCutId[] {
  return [...covered];
}

/** Throws listing every manifest cut that has no test. */
export function assertFaultCutsCovered(): void {
  const missing = FAULT_CUTS.filter((cut) => !covered.has(cut));
  if (missing.length > 0) {
    throw new Error(`Fault cuts without tests: ${missing.join(', ')}`);
  }
}
