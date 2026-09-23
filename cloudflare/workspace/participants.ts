// Participant links, consent and greeting/interview admission budgets.
// STUB: replaced by the implementing milestone.

import type * as Port from '../../src/lib/storage/types';
import type * as Rpc from './rpcTypes';
import type { WorkspaceContext } from './context';

export async function createParticipantLink(ws: WorkspaceContext, input: Rpc.CreateLinkRecordInput): Promise<Rpc.CreateLinkRecordOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.createParticipantLink is not implemented');
}

export async function getParticipantLink(ws: WorkspaceContext, input: Rpc.GetLinkInput): Promise<Port.LinkLoadOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.getParticipantLink is not implemented');
}

export async function listParticipantLinks(ws: WorkspaceContext, input: Rpc.ListLinksInput): Promise<Port.LinkListOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.listParticipantLinks is not implemented');
}

export async function revokeParticipantLink(ws: WorkspaceContext, input: Rpc.RevokeLinkInput): Promise<Port.LinkRevokeOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.revokeParticipantLink is not implemented');
}

export async function recordConsent(ws: WorkspaceContext, input: Rpc.ConsentInput): Promise<Port.RecordConsentOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.recordConsent is not implemented');
}

export async function verifyConsent(ws: WorkspaceContext, input: Rpc.ConsentInput): Promise<Port.VerifyConsentOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.verifyConsent is not implemented');
}

export async function admitParticipantRequest(ws: WorkspaceContext, input: Port.AdmissionInput): Promise<Port.AdmissionOutcome> {
  void ws; void input;
  throw new Error('WorkspaceStore.admitParticipantRequest is not implemented');
}
