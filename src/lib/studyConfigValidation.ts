import {
  AIProviderType,
  StudyConfig,
} from '@/types';
import { readBoundedJsonObject } from './requestBody';
import { isKnownProviderModel } from './providerRegistry';
import { CONSENT_TEXT_PLACEHOLDER, CONSENT_TEXT_PLACEHOLDER_ERROR } from './consentText';

export const STUDY_MUTATION_MAX_BYTES = 128 * 1024;

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_RESEARCH_QUESTION_LENGTH = 4_000;
const MAX_CONSENT_TEXT_LENGTH = 20_000;
const MAX_QUESTION_COUNT = 50;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_TOPIC_COUNT = 50;
const MAX_TOPIC_LENGTH = 500;
const MAX_PROFILE_FIELD_COUNT = 50;
const MAX_PROFILE_FIELD_ID_LENGTH = 100;
const MAX_PROFILE_LABEL_LENGTH = 200;
const MAX_EXTRACTION_HINT_LENGTH = 1_000;
const MAX_PROFILE_OPTION_COUNT = 20;
const MAX_PROFILE_OPTION_LENGTH = 500;
const MAX_ID_LENGTH = 200;
const MAX_MODEL_LENGTH = 200;

const STUDY_CONFIG_FIELDS = new Set([
  'id',
  'name',
  'description',
  'researchQuestion',
  'coreQuestions',
  'topicAreas',
  'profileSchema',
  'aiBehavior',
  'aiProvider',
  'aiModel',
  'consentText',
  'createdAt',
  'parentStudyId',
  'parentStudyName',
  'generatedFrom',
  'linksEnabled',
  'linkExpiration',
  'enableReasoning',
]);

const PROFILE_FIELD_FIELDS = new Set([
  'id',
  'label',
  'extractionHint',
  'required',
  'options',
]);

type ValidationResult =
  | { ok: true; config: StudyConfig }
  | { ok: false; error: string };

export type StudyMutationBody = {
  config?: unknown;
  confirmed?: boolean;
  linksEnabled?: boolean;
};

export type StudyMutationBodyResult =
  | { ok: true; body: StudyMutationBody }
  | { ok: false; status: 400 | 413; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, maximum: number, requireContent = false): value is string {
  return typeof value === 'string'
    && value.length <= maximum
    && (!requireContent || value.trim().length > 0);
}

function validateStringArray(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
  requireItemContent = true
): value is string[] {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every((item) => isBoundedString(item, maximumItemLength, requireItemContent));
}

function validateProfileSchema(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_PROFILE_FIELD_COUNT) return false;

  const fieldIds = new Set<string>();
  for (const field of value) {
    if (!isRecord(field) || !hasOnlyFields(field, PROFILE_FIELD_FIELDS)) return false;
    if (!isBoundedString(field.id, MAX_PROFILE_FIELD_ID_LENGTH, true)) return false;
    if (!/^[A-Za-z0-9_-]+$/.test(field.id) || fieldIds.has(field.id)) return false;
    if (!isBoundedString(field.label, MAX_PROFILE_LABEL_LENGTH, true)) return false;
    if (!isBoundedString(field.extractionHint, MAX_EXTRACTION_HINT_LENGTH, true)) return false;
    if (typeof field.required !== 'boolean') return false;
    if (field.options !== undefined) {
      if (!validateStringArray(
        field.options,
        MAX_PROFILE_OPTION_COUNT,
        MAX_PROFILE_OPTION_LENGTH
      )) return false;
      if (new Set(field.options).size !== field.options.length) return false;
    }
    fieldIds.add(field.id);
  }
  return true;
}

function validateModel(provider: unknown, model: unknown): boolean {
  // Canonical studies must bind the data processor and requested model. Older
  // records may omit these fields, but they must be deliberately reviewed and
  // saved (which advances the study revision) before participant use resumes.
  if (provider === undefined || model === undefined) return false;
  if (
    provider !== 'gemini'
    && provider !== 'claude'
    && provider !== 'openai'
    && provider !== 'openrouter'
  ) return false;
  return isBoundedString(model, MAX_MODEL_LENGTH, true)
    && isKnownProviderModel(provider as AIProviderType, model);
}

/**
 * Strict runtime validation for a complete canonical StudyConfig. It rejects
 * unknown top-level and nested fields so untrusted JSON cannot be persisted and
 * later interpreted as trusted study configuration.
 */
export function validateStudyConfig(value: unknown): ValidationResult {
  if (!isRecord(value) || !hasOnlyFields(value, STUDY_CONFIG_FIELDS)) {
    return { ok: false, error: 'Invalid study configuration fields' };
  }

  if (!isBoundedString(value.id, MAX_ID_LENGTH, true)
    || !/^[A-Za-z0-9-]+$/.test(value.id)) {
    return { ok: false, error: 'Invalid study ID' };
  }
  if (!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0) {
    return { ok: false, error: 'Invalid study creation timestamp' };
  }
  if (!isBoundedString(value.name, MAX_NAME_LENGTH, true)) {
    return { ok: false, error: 'Study name is required and must be 200 characters or fewer' };
  }
  if (!isBoundedString(value.description, MAX_DESCRIPTION_LENGTH)) {
    return { ok: false, error: 'Study description must be 10000 characters or fewer' };
  }
  if (!isBoundedString(value.researchQuestion, MAX_RESEARCH_QUESTION_LENGTH, true)) {
    return { ok: false, error: 'Research question is required and must be 4000 characters or fewer' };
  }
  if (!validateStringArray(value.coreQuestions, MAX_QUESTION_COUNT, MAX_QUESTION_LENGTH)
    || value.coreQuestions.length === 0) {
    return { ok: false, error: 'Provide between 1 and 50 bounded core questions' };
  }
  if (!validateStringArray(value.topicAreas, MAX_TOPIC_COUNT, MAX_TOPIC_LENGTH)) {
    return { ok: false, error: 'Invalid topic areas' };
  }
  if (!validateProfileSchema(value.profileSchema)) {
    return { ok: false, error: 'Invalid profile schema' };
  }
  if (!['structured', 'standard', 'exploratory'].includes(value.aiBehavior as string)) {
    return { ok: false, error: 'Invalid AI behavior' };
  }
  if (!validateModel(value.aiProvider, value.aiModel)) {
    return { ok: false, error: 'AI model is not compatible with the selected provider' };
  }
  if (!isBoundedString(value.consentText, MAX_CONSENT_TEXT_LENGTH, true)) {
    return { ok: false, error: 'Consent text is required and must be 20000 characters or fewer' };
  }

  if (value.parentStudyId !== undefined
    && (!isBoundedString(value.parentStudyId, MAX_ID_LENGTH, true)
      || !/^[A-Za-z0-9-]+$/.test(value.parentStudyId))) {
    return { ok: false, error: 'Invalid parent study ID' };
  }
  if (value.parentStudyName !== undefined
    && !isBoundedString(value.parentStudyName, MAX_NAME_LENGTH, true)) {
    return { ok: false, error: 'Invalid parent study name' };
  }
  if (value.generatedFrom !== undefined
    && value.generatedFrom !== 'synthesis'
    && value.generatedFrom !== 'manual') {
    return { ok: false, error: 'Invalid study lineage type' };
  }
  if (value.linksEnabled !== undefined && typeof value.linksEnabled !== 'boolean') {
    return { ok: false, error: 'Invalid participant link status' };
  }
  if (value.linkExpiration !== undefined
    && !['never', '7days', '30days', '90days'].includes(value.linkExpiration as string)) {
    return { ok: false, error: 'Invalid link expiration' };
  }
  if (value.enableReasoning !== undefined && typeof value.enableReasoning !== 'boolean') {
    return { ok: false, error: 'Invalid AI reasoning setting' };
  }
  return { ok: true, config: value as unknown as StudyConfig };
}

/** Apply authoritative server identity before validating a create payload. */
export function validateStudyConfigForCreate(
  value: unknown,
  serverOwned: { id: string; createdAt: number }
): ValidationResult {
  if (!isRecord(value)) return { ok: false, error: 'Missing required field: config' };
  const result = validateStudyConfig({ ...value, ...serverOwned });
  if (result.ok && CONSENT_TEXT_PLACEHOLDER.test(result.config.consentText)) {
    return { ok: false, error: CONSENT_TEXT_PLACEHOLDER_ERROR };
  }
  return result;
}

/** Merge a partial edit into canonical state while protecting server-owned fields. */
export function validateStudyConfigUpdate(
  current: StudyConfig,
  patch: unknown,
  linksEnabled: boolean | undefined
): ValidationResult {
  if (!isRecord(patch)) return { ok: false, error: 'Missing required field: config' };
  if (patch.id !== undefined && patch.id !== current.id) {
    return { ok: false, error: 'Study ID is server-owned and cannot be changed' };
  }
  if (patch.createdAt !== undefined && patch.createdAt !== current.createdAt) {
    return { ok: false, error: 'Study creation timestamp is server-owned and cannot be changed' };
  }

  const { id: _id, createdAt: _createdAt, linksEnabled: _embeddedLinkStatus, ...editable } = patch;
  const result = validateStudyConfig({
    ...current,
    ...editable,
    id: current.id,
    createdAt: current.createdAt,
    linksEnabled: linksEnabled ?? current.linksEnabled,
  });
  if (result.ok && CONSENT_TEXT_PLACEHOLDER.test(result.config.consentText)) {
    return { ok: false, error: CONSENT_TEXT_PLACEHOLDER_ERROR };
  }
  return result;
}

/** Bounded, strict parsing for researcher study create/update request bodies. */
export async function readStudyMutationBody(
  request: Request,
  operation: 'create' | 'update'
): Promise<StudyMutationBodyResult> {
  const parsed = await readBoundedJsonObject(request, STUDY_MUTATION_MAX_BYTES);
  if (!parsed.ok) {
    return {
      ok: false,
      status: parsed.status,
      error: parsed.status === 413 ? 'Request body is too large' : 'Invalid request body',
    };
  }

  const allowed = operation === 'create'
    ? new Set(['config'])
    : new Set(['config', 'confirmed', 'linksEnabled']);
  if (!hasOnlyFields(parsed.value, allowed)) {
    return { ok: false, status: 400, error: 'Invalid request body fields' };
  }
  if (operation === 'create' && parsed.value.config === undefined) {
    return { ok: false, status: 400, error: 'Missing required field: config' };
  }
  if (parsed.value.confirmed !== undefined && typeof parsed.value.confirmed !== 'boolean') {
    return { ok: false, status: 400, error: 'Invalid confirmation value' };
  }
  if (parsed.value.linksEnabled !== undefined && typeof parsed.value.linksEnabled !== 'boolean') {
    return { ok: false, status: 400, error: 'Invalid participant link status' };
  }

  return {
    ok: true,
    body: {
      config: parsed.value.config,
      confirmed: parsed.value.confirmed as boolean | undefined,
      linksEnabled: parsed.value.linksEnabled as boolean | undefined,
    },
  };
}
