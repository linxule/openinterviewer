// Organization metadata only: never part of study configuration or participant authority.
import type { WorkspaceHoldReason } from '../storage/types';

export const MAX_PROJECTS = 1_000;
export const MAX_PROJECT_STUDIES = 1_000;
export type Project = { id: string; name: string; createdAt: number; updatedAt: number };
export type StudyProjectMembership = { studyId: string; projectId: string };
export type ProjectFailure =
  | { status: 'not-found' | 'study-not-found' | 'conflict' | 'persist-guard' | 'too-large' | 'quota' | 'unavailable' | 'ambiguous' }
  | { status: 'held'; reason: WorkspaceHoldReason };
export type ProjectListOutcome = { status: 'ok'; projects: Project[]; memberships: StudyProjectMembership[]; studyIds: string[] } | ProjectFailure;
export type ProjectReadOutcome = { status: 'found'; project: Project; studyIds: string[] } | ProjectFailure;
export type ProjectWriteOutcome = { status: 'created'; project: Project } | { status: 'updated'; project: Project } | ProjectFailure;
export type ProjectDeleteOutcome = { status: 'deleted' } | ProjectFailure;
export type ProjectAssignOutcome = { status: 'assigned'; studyId: string; projectId: string | null } | ProjectFailure;
export type ProjectOutcome = ProjectListOutcome | ProjectReadOutcome | ProjectWriteOutcome | ProjectDeleteOutcome | ProjectAssignOutcome;
export interface ProjectsStorePort {
  list(): Promise<ProjectListOutcome>;
  read(input: { projectId: string }): Promise<ProjectReadOutcome>;
  create(input: { name: string }): Promise<ProjectWriteOutcome>;
  rename(input: { projectId: string; name: string }): Promise<ProjectWriteOutcome>;
  delete(input: { projectId: string }): Promise<ProjectDeleteOutcome>;
  assignStudy(input: { studyId: string; projectId: string | null }): Promise<ProjectAssignOutcome>;
}
