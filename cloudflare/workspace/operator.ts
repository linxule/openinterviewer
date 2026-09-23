// Readiness, maintenance modes, operational backup/import and recovery-epoch
// activation (OPS). Only readiness is implemented here so far.

import type * as Port from '../../src/lib/storage/types';
import type * as Rpc from './rpcTypes';
import { gate, readMeta, type WorkspaceContext } from './context';

/** Bounded, write-free readiness: schema, identity, epoch and maintenance state. */
export async function readiness(ws: WorkspaceContext): Promise<Port.StoreReadiness> {
  const meta = readMeta(ws.sql);
  if (!meta) return { status: 'held', reason: 'schema-unsupported' };
  const checked = gate(ws, 'job-settlement');
  if (!checked.ok && checked.reason !== 'maintenance') {
    return { status: 'held', reason: checked.reason, maintenance: meta.maintenanceState };
  }
  return { status: 'ready', maintenance: meta.maintenanceState };
}

export async function operatorStatus(ws: WorkspaceContext): Promise<Rpc.OperatorStatusOutcome> {
  void ws;
  throw new Error('WorkspaceStore.operatorStatus is not implemented');
}

export async function transitionMaintenance(ws: WorkspaceContext, input: Rpc.MaintenanceTransitionInput): Promise<Rpc.MaintenanceTransitionOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.transitionMaintenance is not implemented');
}

export async function exportBackupPage(ws: WorkspaceContext, input: Rpc.BackupPageInput): Promise<Rpc.BackupPageOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.exportBackupPage is not implemented');
}

export async function importBackupChunk(ws: WorkspaceContext, input: Rpc.BackupImportInput): Promise<Rpc.BackupImportOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.importBackupChunk is not implemented');
}

export async function activateRecoveryEpoch(ws: WorkspaceContext, input: Rpc.ActivateEpochInput): Promise<Rpc.ActivateEpochOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.activateRecoveryEpoch is not implemented');
}
