import {
  BehaviorData,
  InterviewMessage,
  ParticipantProfile,
  StoredInterview,
  SynthesisResult,
} from '@/types';
import { validateSynthesisResult } from './providerValidation';

const ID = /^[A-Za-z0-9_-]{1,120}$/;
const PROFILE_STATUSES = new Set(['pending', 'extracted', 'vague', 'refused']);
const ROLES = new Set(['user', 'ai', 'system']);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function stringList(value: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems || !value.every(item => boundedString(item, maximumLength, true))) {
    throw new Error('Invalid interview submission list');
  }
  return value;
}

function numericMap(value: unknown): Record<string, number> {
  if (!record(value) || Object.keys(value).length > 50) throw new Error('Invalid interview submission metrics');
  const entries = Object.entries(value);
  if (!entries.every(([key, metric]) => boundedString(key, 100) && finiteNonNegative(metric))) {
    throw new Error('Invalid interview submission metrics');
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

export function validateTranscript(value: unknown): InterviewMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new Error('Transcript must contain between 1 and 200 messages');
  }
  return value.map((message) => {
    if (
      !record(message)
      || !boundedString(message.id, 120)
      || !ID.test(message.id)
      || !ROLES.has(String(message.role))
      || !boundedString(message.content, 5_000)
      || !finiteNonNegative(message.timestamp)
    ) {
      throw new Error('Invalid transcript message');
    }
    return {
      id: message.id,
      role: message.role as InterviewMessage['role'],
      content: message.content,
      timestamp: message.timestamp,
    };
  });
}

export function validateProfile(value: unknown): ParticipantProfile | null {
  if (value === undefined || value === null) return null;
  if (
    !record(value)
    || !boundedString(value.id, 120)
    || !ID.test(value.id)
    || !Array.isArray(value.fields)
    || value.fields.length > 50
    || !boundedString(value.rawContext, 10_000, true)
    || !finiteNonNegative(value.timestamp)
  ) {
    throw new Error('Invalid participant profile');
  }
  const fields = value.fields.map((field) => {
    if (
      !record(field)
      || !boundedString(field.fieldId, 120)
      || !ID.test(field.fieldId)
      || !PROFILE_STATUSES.has(String(field.status))
      || (field.value !== null && field.value !== undefined && !boundedString(field.value, 1_000, true))
      || (field.extractedAt !== undefined && !finiteNonNegative(field.extractedAt))
    ) {
      throw new Error('Invalid participant profile field');
    }
    return {
      fieldId: field.fieldId,
      value: field.value === undefined ? null : field.value as string | null,
      status: field.status as ParticipantProfile['fields'][number]['status'],
      ...(typeof field.extractedAt === 'number' ? { extractedAt: field.extractedAt } : {}),
    };
  });
  return {
    id: value.id,
    fields,
    rawContext: value.rawContext,
    timestamp: value.timestamp,
  };
}

export function validateBehavior(value: unknown): BehaviorData {
  if (!record(value)) throw new Error('Invalid behavior data');
  return {
    timePerTopic: numericMap(value.timePerTopic),
    messagesPerTopic: numericMap(value.messagesPerTopic),
    topicsExplored: stringList(value.topicsExplored, 100, 500),
    contradictions: stringList(value.contradictions, 100, 1_000),
  };
}

export interface ValidInterviewSubmission {
  id: string;
  studyId?: string;
  transcript: InterviewMessage[];
  participantProfile: ParticipantProfile | null;
  behaviorData: BehaviorData;
  synthesis: SynthesisResult | null;
  createdAt?: number;
}

// A participant's completed interview is durable the moment it saves; the
// analysis is a separate, server-run act (slice-P). A body carrying no
// synthesis (or an explicit null) is valid; a researcher-preview body may
// still carry one so the preview save path can echo `{ preview: true }`
// without a special client path — see save/route.ts, which discards it on
// the participant path regardless of what a submission asserts here.
export function validateInterviewSubmission(input: unknown): ValidInterviewSubmission {
  if (!record(input) || JSON.stringify(input).length > 512_000) {
    throw new Error('Interview submission is too large or malformed');
  }
  if (!boundedString(input.id, 120) || !ID.test(input.id)) throw new Error('Invalid interview id');
  if (input.studyId !== undefined && (!boundedString(input.studyId, 120) || !ID.test(input.studyId))) {
    throw new Error('Invalid study id');
  }
  const synthesis = input.synthesis === undefined || input.synthesis === null
    ? null
    : validateSynthesisResult(input.synthesis);

  return {
    id: input.id,
    studyId: input.studyId,
    transcript: validateTranscript(input.transcript),
    participantProfile: validateProfile(input.participantProfile),
    behaviorData: validateBehavior(input.behaviorData),
    synthesis,
    createdAt: finiteNonNegative(input.createdAt) ? input.createdAt : undefined,
  };
}

export type InterviewSubmissionInput = Pick<
  StoredInterview,
  'id' | 'studyId' | 'transcript' | 'participantProfile' | 'behaviorData' | 'synthesis' | 'createdAt'
>;
