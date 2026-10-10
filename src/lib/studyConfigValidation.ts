import {
  AIProviderType,
  StudyConfig,
} from '@/types';
import { readBoundedJsonObject } from './requestBody';
import { isKnownProviderModel } from './providerRegistry';
import { CONSENT_TEXT_PLACEHOLDER, CONSENT_TEXT_PLACEHOLDER_ERROR } from './consentText';
import { isProviderCommitment } from './providerCommitment';
import { BRACKETED_PLACEHOLDER, THANK_YOU_TEXT_PLACEHOLDER_ERROR } from './thankYouText';

import { MAX_INTERVIEWER_INSTRUCTIONS_LENGTH } from './interviewerManner';
import { INTERVIEW_LANGUAGES, isInterviewLanguage } from './i18n/languages';

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
const MAX_RESEARCHER_CONTACT_LENGTH = 200;
const MAX_THANK_YOU_TEXT_LENGTH = 4_000;

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
  'aiProviderCommitment',
  'consentText',
  'researcherContact',
  'thankYouText',
  'interviewerInstructions',
  'interviewLanguages',
  'consentTextTranslations',
  'thankYouTextTranslations',
  'voiceInput',
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
  expectedRevision?: number;
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
 * Interview languages (lib/i18n/languages.ts). Optional, so every study saved
 * before the setting keeps serving participants. With it: one to six distinct
 * languages; a non-empty consent text for each language after the first (the
 * first uses `consentText`); optional thank-you text for those languages; and
 * no translation for a language the study does not offer.
 */
function validateInterviewLanguages(value: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  const languages = value.interviewLanguages;
  const consent = value.consentTextTranslations;
  const thankYou = value.thankYouTextTranslations;
  if (languages === undefined) {
    return consent === undefined && thankYou === undefined
      ? { ok: true }
      : { ok: false, error: 'Translations need interview languages' };
  }
  if (!Array.isArray(languages)
    || languages.length === 0
    || languages.length > INTERVIEW_LANGUAGES.length
    || !languages.every(isInterviewLanguage)
    || new Set(languages).size !== languages.length) {
    return { ok: false, error: 'Choose between one and six different interview languages' };
  }
  const additional = new Set<string>(languages.slice(1));
  for (const [map, required, maximum, label] of [
    [consent, true, MAX_CONSENT_TEXT_LENGTH, 'Consent text'],
    [thankYou, false, MAX_THANK_YOU_TEXT_LENGTH, 'Thank-you screen'],
  ] as const) {
    if (map === undefined) {
      if (required && additional.size > 0) return { ok: false, error: 'Consent text is required for every interview language' };
      continue;
    }
    if (!isRecord(map)) return { ok: false, error: `${label} translations are invalid` };
    for (const [language, text] of Object.entries(map)) {
      if (!additional.has(language)) return { ok: false, error: `${label} translations must match the interview languages` };
      if (!isBoundedString(text, maximum, true)) return { ok: false, error: `${label} for each language must be ${maximum} characters or fewer` };
    }
    if (required && [...additional].some((language) => !Object.prototype.hasOwnProperty.call(map, language))) {
      return { ok: false, error: 'Consent text is required for every interview language' };
    }
  }
  return { ok: true };
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
  if (value.aiProviderCommitment !== undefined && !isProviderCommitment(value.aiProviderCommitment)) {
    return { ok: false, error: 'Invalid AI provider commitment' };
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
  if (value.researcherContact !== undefined
    && !isBoundedString(value.researcherContact, MAX_RESEARCHER_CONTACT_LENGTH, true)) {
    return { ok: false, error: 'Researcher contact must be 200 characters or fewer' };
  }
  // Optional, and not placeholder-checked here: this function also runs on
  // every participant request via loadCanonicalStudy, and a study saved
  // before this field existed must keep serving participants (slice-P §P12.2).
  if (value.thankYouText !== undefined
    && !isBoundedString(value.thankYouText, MAX_THANK_YOU_TEXT_LENGTH, true)) {
    return { ok: false, error: 'Thank-you screen must be 4000 characters or fewer' };
  }
  if (value.interviewerInstructions !== undefined
    && !isBoundedString(value.interviewerInstructions, MAX_INTERVIEWER_INSTRUCTIONS_LENGTH, true)) {
    return { ok: false, error: 'Interviewer instructions must be 4000 characters or fewer' };
  }
  const languages = validateInterviewLanguages(value);
  if (!languages.ok) return languages;
  if (value.voiceInput !== undefined && !['off', 'installation', 'browser', 'device'].includes(value.voiceInput as string)) {
    return { ok: false, error: 'Invalid voice input setting' };
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

/** Save-time only, like the checks above: an unfilled placeholder in any translation. */
function translationPlaceholderRefusal(result: ValidationResult): ValidationResult {
  if (!result.ok) return result;
  if (Object.values(result.config.consentTextTranslations ?? {}).some((text) => text !== undefined && CONSENT_TEXT_PLACEHOLDER.test(text))) {
    return { ok: false, error: CONSENT_TEXT_PLACEHOLDER_ERROR };
  }
  if (Object.values(result.config.thankYouTextTranslations ?? {}).some((text) => text !== undefined && BRACKETED_PLACEHOLDER.test(text))) {
    return { ok: false, error: THANK_YOU_TEXT_PLACEHOLDER_ERROR };
  }
  return result;
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
  if (result.ok && result.config.thankYouText !== undefined
    && BRACKETED_PLACEHOLDER.test(result.config.thankYouText)) {
    return { ok: false, error: THANK_YOU_TEXT_PLACEHOLDER_ERROR };
  }
  return translationPlaceholderRefusal(result);
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
  const merged = {
    ...current,
    ...editable,
    id: current.id,
    createdAt: current.createdAt,
    linksEnabled: linksEnabled ?? current.linksEnabled,
  };
  for (const field of ['interviewerInstructions', 'thankYouText'] as const) {
    if (editable[field] === '') delete merged[field];
  }
  // An empty map clears a translation set (JSON cannot send undefined).
  for (const field of ['consentTextTranslations', 'thankYouTextTranslations'] as const) {
    const sent = editable[field];
    if (isRecord(sent) && Object.keys(sent).length === 0) delete merged[field];
  }
  const result = validateStudyConfig(merged);
  if (result.ok && CONSENT_TEXT_PLACEHOLDER.test(result.config.consentText)) {
    return { ok: false, error: CONSENT_TEXT_PLACEHOLDER_ERROR };
  }
  if (result.ok && result.config.thankYouText !== undefined
    && BRACKETED_PLACEHOLDER.test(result.config.thankYouText)) {
    return { ok: false, error: THANK_YOU_TEXT_PLACEHOLDER_ERROR };
  }
  return translationPlaceholderRefusal(result);
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
    : new Set(['config', 'confirmed', 'linksEnabled', 'expectedRevision']);
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
  if (parsed.value.expectedRevision !== undefined
    && (!Number.isSafeInteger(parsed.value.expectedRevision) || (parsed.value.expectedRevision as number) < 1)) {
    return { ok: false, status: 400, error: 'Invalid expected study revision' };
  }

  return {
    ok: true,
    body: {
      config: parsed.value.config,
      confirmed: parsed.value.confirmed as boolean | undefined,
      linksEnabled: parsed.value.linksEnabled as boolean | undefined,
      expectedRevision: parsed.value.expectedRevision as number | undefined,
    },
  };
}
