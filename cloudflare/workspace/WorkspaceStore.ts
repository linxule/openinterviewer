// The standalone workspace's single transactional authority (02-storage.md,
// 03-analysis-jobs.md). One SQLite-backed object per installation workspace,
// selected by the server-owned WORKSPACE_ID. HTTP input never selects an
// object, table or SQL. No provider call, credential or public SQL surface
// lives here.

import { DurableObject } from 'cloudflare:workers';
import type * as Port from '../../src/lib/storage/types';
import type * as Protocol from '../../src/lib/storage/analysisProtocol';
import { isValidRecoveryEpoch, isValidWorkspaceId } from '../../src/lib/storage/analysisProtocol';
import { applyMigrations } from './migrate';
import { HELD_ALARM_RETRY_MS, readMeta, type WorkspaceContext, type WorkspaceEnv } from './context';
import * as studies from './studies';
import * as participants from './participants';
import * as budget from './budget';
import * as completion from './completion';
import * as reads from './reads';
import * as sample from './sample';
import * as analysis from './analysis';
import * as scheduler from './scheduler';
import * as exporter from './exports';
import * as operator from './operator';
import * as login from './login';
import type * as Rpc from './rpcTypes';
import type { StudyListItem } from '../../src/types';

type InitState =
  | { status: 'ready' }
  | { status: 'schema-unsupported' }
  | { status: 'unconfigured' }
  | { status: 'identity-mismatch' }
  | { status: 'uninitialized' };

export class WorkspaceStore extends DurableObject<WorkspaceEnv> {
  private initState: InitState = { status: 'unconfigured' };

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);
    // Bounded storage-only work: migrations and first-time metadata.
    ctx.blockConcurrencyWhile(async () => {
      this.initState = this.initialize();
    });
  }

  private get ws(): WorkspaceContext {
    return {
      sql: this.ctx.storage.sql,
      storage: this.ctx.storage,
      env: this.env,
      objectName: this.ctx.id.name,
    };
  }

  private initialize(): InitState {
    const sql = this.ctx.storage.sql;
    // Each migration and its ledger row commit together; a throw here resets
    // the object and the next start retries (ST-09, migrate.ts).
    if (applyMigrations(this.ctx.storage).status !== 'ready') return { status: 'schema-unsupported' };
    if (!readMeta(sql)) {
      const workspaceId = this.env.WORKSPACE_ID;
      const epoch = this.env.ANALYSIS_RECOVERY_EPOCH;
      const bootstrap = this.env.WORKSPACE_BOOTSTRAP;
      // A fresh object initializes only under an explicit installer-set
      // bootstrap state. Without it, an empty object reached through identity,
      // jurisdiction or Worker-name drift stays uninitialized and refuses all
      // writes instead of silently becoming an empty writable workspace. An
      // object selected under another name never initializes as this one.
      //
      // A missing or malformed WORKSPACE_ID or epoch is reported apart from a
      // name mismatch: it is what a version running before the installer's
      // secret upload looks like, and it clears once the configuration
      // arrives, where a mismatch needs operator repair.
      if (!isValidWorkspaceId(workspaceId) || !isValidRecoveryEpoch(epoch)) return { status: 'unconfigured' };
      if (this.ctx.id.name !== undefined && this.ctx.id.name !== workspaceId) return { status: 'identity-mismatch' };
      if (bootstrap !== 'open' && bootstrap !== 'recovery') return { status: 'uninitialized' };
      const now = Date.now();
      sql.exec(
        `INSERT INTO workspace_meta (singleton, workspace_id, activated_epoch, maintenance_state,
           maintenance_version, mutation_seq, created_at, updated_at)
         VALUES (1, ?, ?, ?, 0, 0, ?, ?)`,
        workspaceId,
        epoch,
        bootstrap,
        now,
        now,
      );
    }
    return { status: 'ready' };
  }

  private requireInitialized(): Port.WorkspaceHoldReason | null {
    if (this.initState.status === 'ready') return null;
    if (this.initState.status === 'schema-unsupported') return 'schema-unsupported';
    // Configuration may have been supplied after the first attempt.
    this.initState = this.initialize();
    if (this.initState.status === 'ready') return null;
    if (this.initState.status === 'schema-unsupported') return 'schema-unsupported';
    if (this.initState.status === 'uninitialized') return 'workspace-uninitialized';
    if (this.initState.status === 'unconfigured') return 'workspace-unconfigured';
    return 'workspace-identity-mismatch';
  }

  // ---------- Readiness ----------

  async readiness(): Promise<Port.StoreReadiness> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return operator.readiness(this.ws);
  }

  // ---------- Studies ----------

  async getStudy(input: Rpc.StudyIdInput): Promise<Port.StudyLoadResult> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return studies.getStudy(this.ws, input);
  }

  async listStudies(
    input: studies.ListStudiesRequest,
  ): Promise<Port.CollectionLoadResult<Rpc.StoredStudy | StudyListItem> | studies.ListStudiesPage> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return studies.listStudies(this.ws, input);
  }

  async createStudy(input: Port.CreateStudyInput): Promise<Port.CreateStudyOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return studies.createStudy(this.ws, input);
  }

  async replaceStudyConfig(input: Rpc.ReplaceStudyConfigInput): Promise<Port.StudyMutationOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return studies.replaceStudyConfig(this.ws, input);
  }

  async setStudyLinksEnabled(input: Rpc.SetLinksEnabledInput): Promise<Port.StudyMutationOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return studies.setStudyLinksEnabled(this.ws, input);
  }

  async deleteStudy(input: Rpc.DeleteStudyInput): Promise<Port.DeleteStudyOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held, success: false };
    return studies.deleteStudy(this.ws, input);
  }

  // ---------- Participant links, consent, admission ----------

  async createParticipantLink(input: Rpc.CreateLinkRecordInput): Promise<Rpc.CreateLinkRecordOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return participants.createParticipantLink(this.ws, input);
  }

  async getParticipantLink(input: Rpc.GetLinkInput): Promise<Port.LinkLoadOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return participants.getParticipantLink(this.ws, input);
  }

  async listParticipantLinks(input: Rpc.ListLinksInput): Promise<Port.LinkListOutcome> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return participants.listParticipantLinks(this.ws, input);
  }

  async revokeParticipantLink(input: Rpc.RevokeLinkInput): Promise<Port.LinkRevokeOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return participants.revokeParticipantLink(this.ws, input);
  }

  async recordConsent(input: Rpc.ConsentInput): Promise<Port.RecordConsentOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return participants.recordConsent(this.ws, input);
  }

  async verifyConsent(input: Rpc.ConsentInput): Promise<Port.VerifyConsentOutcome> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return participants.verifyConsent(this.ws, input);
  }

  async admitParticipantRequest(input: Port.AdmissionInput): Promise<Port.AdmissionOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return participants.admitParticipantRequest(this.ws, input);
  }

  async admitResearcherAiRequest(input: Port.ResearcherAiAdmissionInput): Promise<Port.AdmissionOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return budget.admitResearcherAiRequest(this.ws, input);
  }

  // ---------- Completion ----------

  async persistCompletedInterview(input: Rpc.PersistInput): Promise<Port.PersistCompletedInterviewOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return completion.persistCompletedInterview(this.ws, input);
  }

  // ---------- Reads ----------

  async getInterview(input: Rpc.InterviewIdInput): Promise<Port.InterviewLoadResult> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return reads.getInterview(this.ws, input);
  }

  async listInterviews(input: Port.ListInterviewsInput): Promise<Port.CollectionLoadResult<Rpc.StoredInterview>> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return reads.listInterviews(this.ws, input);
  }

  async getAggregate(input: Rpc.StudyIdInput): Promise<Port.AggregateLoadResult> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return reads.getAggregate(this.ws, input);
  }

  async saveAggregate(input: Rpc.SaveAggregateInput): Promise<Port.SaveAggregateOutcome> {
    if (this.requireInitialized()) return 'held';
    return reads.saveAggregate(this.ws, input);
  }

  async readAggregateInputs(input: Rpc.AggregateInputsInput): Promise<Rpc.AggregateInputsOutcome> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return reads.readAggregateInputs(this.ws, input);
  }

  // ---------- Sample workspace ----------

  async seedSampleWorkspace(input: Port.SeedSampleInput): Promise<Port.SeedSampleOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return sample.seedSampleWorkspace(this.ws, input);
  }

  async clearSampleWorkspace(input: Port.ClearSampleInput & { now: number }): Promise<Port.ClearSampleOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return sample.clearSampleWorkspace(this.ws, input);
  }

  // ---------- Durable analysis (researcher API) ----------

  async acceptAnalysisRetry(input: Protocol.AcceptAnalysisRetryInput): Promise<Protocol.AcceptAnalysisRetryOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return analysis.acceptAnalysisRetry(this.ws, input);
  }

  async readAnalysisStatus(input: Rpc.AnalysisStatusInput): Promise<Protocol.ReadAnalysisStatusOutcome> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return analysis.readAnalysisStatus(this.ws, input);
  }

  // ---------- Durable analysis (Queue consumer only) ----------

  async claimAnalysisJob(input: Protocol.ClaimAnalysisJobInput): Promise<Protocol.ClaimAnalysisJobOutcome> {
    if (this.requireInitialized()) return { status: 'held' };
    return analysis.claimAnalysisJob(this.ws, input);
  }

  async markAnalysisStarted(input: Protocol.MarkStartedInput): Promise<Protocol.MarkStartedOutcome> {
    if (this.requireInitialized()) return { status: 'held' };
    return analysis.markAnalysisStarted(this.ws, input);
  }

  async finishAnalysisJob(input: Protocol.FinishAnalysisJobInput): Promise<Protocol.FinishAnalysisJobOutcome> {
    if (this.requireInitialized()) return { status: 'held' };
    return analysis.finishAnalysisJob(this.ws, input);
  }

  // ---------- Researcher export (snapshot-fenced paging) ----------

  async beginExport(input: Rpc.BeginExportInput): Promise<Rpc.BeginExportOutcome> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return exporter.beginExport(this.ws, input);
  }

  async readExportPage(input: Rpc.ExportPageInput): Promise<Rpc.ExportPageOutcome> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return exporter.readExportPage(this.ws, input);
  }

  async verifyExportSequence(input: Rpc.ExportSequenceInput): Promise<Rpc.ExportSequenceOutcome> {
    if (this.requireInitialized()) return { status: 'unavailable' };
    return exporter.verifyExportSequence(this.ws, input);
  }

  // ---------- Operator surface (OPS) ----------

  async operatorStatus(): Promise<Rpc.OperatorStatusOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return operator.operatorStatus(this.ws);
  }

  async transitionMaintenance(input: Rpc.MaintenanceTransitionInput): Promise<Rpc.MaintenanceTransitionOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return operator.transitionMaintenance(this.ws, input);
  }

  async exportBackupPage(input: Rpc.BackupPageInput): Promise<Rpc.BackupPageOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return operator.exportBackupPage(this.ws, input);
  }

  async importBackupChunk(input: Rpc.BackupImportInput): Promise<Rpc.BackupImportOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return operator.importBackupChunk(this.ws, input);
  }

  async activateRecoveryEpoch(input: Rpc.ActivateEpochInput): Promise<Rpc.ActivateEpochOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    return operator.activateRecoveryEpoch(this.ws, input);
  }

  async restoreToBookmark(input: Rpc.RestoreBookmarkInput): Promise<Rpc.RestoreBookmarkOutcome> {
    const held = this.requireInitialized();
    if (held) return { status: 'held', reason: held };
    const outcome = await operator.restoreToBookmark(this.ws, input, this.ctx.storage);
    if (outcome.status === 'scheduled') this.restartAfterReply();
    return outcome;
  }

  /**
   * A scheduled point-in-time restore applies when the next session opens.
   * This call's reply goes out first; the object then takes no other event
   * and resets, so nothing is served from the storage the restore replaces.
   */
  private restartAfterReply(): void {
    this.ctx
      .blockConcurrencyWhile(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        this.ctx.abort('point-in-time restore scheduled');
      })
      .catch(() => undefined);
  }

  // ---------- Researcher sign-in budget (gap F5) ----------
  // Every maintenance state and every epoch/identity hold allows these, so an
  // operator can sign in to a frozen, recovering or held workspace. Only a
  // schema this build cannot read refuses: the table may not exist there.
  // Admission counts the attempt atomically before the password is compared.

  async admitLoginAttempt(input: Rpc.LoginAttemptInput): Promise<Rpc.LoginAdmitOutcome> {
    if (this.requireInitialized() === 'schema-unsupported') return { status: 'held', reason: 'schema-unsupported' };
    return login.admitLoginAttempt(this.ws, input);
  }

  async refundLoginAttempt(input: Rpc.LoginAttemptInput): Promise<Rpc.LoginRefundOutcome> {
    if (this.requireInitialized() === 'schema-unsupported') return { status: 'held', reason: 'schema-unsupported' };
    return login.refundLoginAttempt(this.ws, input);
  }

  // ---------- The single alarm (JOB-06/07) ----------

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    if (this.requireInitialized()) {
      // A held object keeps one hourly wake-up so a compatible redeploy or a
      // completed bootstrap resumes dispatch without waiting for a request.
      await this.ctx.storage.setAlarm(Date.now() + HELD_ALARM_RETRY_MS);
      return;
    }
    await scheduler.runAlarm(this.ws, alarmInfo);
  }
}
