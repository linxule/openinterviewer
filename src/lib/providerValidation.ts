// Runtime validation for AI provider domain outputs.
// Pure and dependency-free: validators raise plain Errors describing the shape
// problem (never echoing provider data); providers wrap them in
// ProviderFailure('invalid-response'). Malformed output is rejected outright —
// we never substitute canned speech or default domain data for missing fields.

import {
  AIInterviewResponse,
  InterviewPhase,
  SynthesisResult,
  SynthesisTheme,
  EvidenceRef,
  AggregateSynthesisResult,
  AggregateSynthesisProviderPayload,
  AggregateThemeClaim,
  AggregateQuoteClaim,
  AggregateTheme,
} from '@/types';
import { MAX_AGGREGATE_QUOTE_REFS } from '@/lib/prompts/synthesis';

type UnknownRecord = Record<string, unknown>;

const INTERVIEW_PHASES: readonly string[] = [
  'background',
  'core-questions',
  'exploration',
  'feedback',
  'wrap-up',
];

const PROFILE_UPDATE_STATUSES: readonly string[] = ['extracted', 'vague', 'refused'];
const MAX_PROVIDER_TEXT = 20_000;
const MAX_PROVIDER_LIST_ITEMS = 100;
const MAX_PROFILE_UPDATES = 50;
const MAX_FIELD_ID = 100;
const MAX_PROFILE_VALUE = 4_000;
// Matches synthesisResponseSchema's evidenceRefs.maxItems (providerSchemas.ts).
// tests/unit/synthesisSchema.roundTrip.test.ts pins the two values equal.
export const MAX_EVIDENCE_REFS = 3;
const MAX_EVIDENCE_QUOTE = 2_000;
const INTERVIEW_ID = /^[A-Za-z0-9_-]{1,120}$/;
// Matches the aggregate route's own collection ceiling
// (getStudyInterviewsChecked(..., 1_000) in aggregate/route.ts and
// generate-followup/route.ts). Bounds the shape only; the route is the one
// place that knows how many interviews actually loaded.
const MAX_AGGREGATE_INTERVIEW_INDEX = 1_000;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_PROVIDER_TEXT;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// 0-based question index: whole numbers only.
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// 1-based turn index: whole numbers only.
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isStringArray(
  value: unknown,
  maximumItems = MAX_PROVIDER_LIST_ITEMS,
  maximumLength = MAX_PROVIDER_TEXT
): value is string[] {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every(item => typeof item === 'string' && item.length <= maximumLength);
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

function fail(shape: string, field: string, expectation: string): never {
  throw new Error(`invalid ${shape}: ${field} ${expectation}`);
}

// ============================================
// Interview response
// ============================================

export function validateInterviewResponse(input: unknown): AIInterviewResponse {
  if (!isRecord(input)) {
    fail('interview response', 'root', 'must be an object');
  }
  if (!isNonEmptyString(input.message)) {
    fail('interview response', 'message', 'must be a non-empty string');
  }
  if (input.questionAddressed === undefined
    || (input.questionAddressed !== null && !isNonNegativeInteger(input.questionAddressed))) {
    fail('interview response', 'questionAddressed', 'must be a non-negative integer or null');
  }
  if (input.phaseTransition === undefined
    || (input.phaseTransition !== null && !isOneOf(input.phaseTransition, INTERVIEW_PHASES))) {
    fail('interview response', 'phaseTransition', 'must be a valid interview phase or null');
  }
  if (!Array.isArray(input.profileUpdates)) {
    fail('interview response', 'profileUpdates', 'must be an array');
  }
  if (input.profileUpdates.length > MAX_PROFILE_UPDATES) {
    fail('interview response', 'profileUpdates', `must contain at most ${MAX_PROFILE_UPDATES} items`);
  }
  const profileUpdates = input.profileUpdates.map((item, i) => {
    if (!isRecord(item)) {
      fail('interview response', `profileUpdates[${i}]`, 'must be an object');
    }
    if (!isNonEmptyString(item.fieldId) || item.fieldId.length > MAX_FIELD_ID) {
      fail('interview response', `profileUpdates[${i}].fieldId`, 'must be a non-empty string');
    }
    if (!isOneOf(item.status, PROFILE_UPDATE_STATUSES)) {
      fail('interview response', `profileUpdates[${i}].status`, 'must be extracted, vague, or refused');
    }
    if (
      item.value !== null
      && (typeof item.value !== 'string' || item.value.length > MAX_PROFILE_VALUE)
    ) {
      fail('interview response', `profileUpdates[${i}].value`, 'must be a string or null');
    }
    return {
      fieldId: item.fieldId,
      value: item.value,
      status: item.status as AIInterviewResponse['profileUpdates'][number]['status'],
    };
  });
  if (typeof input.shouldConclude !== 'boolean') {
    fail('interview response', 'shouldConclude', 'must be a boolean');
  }
  return {
    message: input.message,
    questionAddressed: input.questionAddressed === null
      ? null
      : input.questionAddressed,
    phaseTransition: input.phaseTransition === null
      ? null
      : (input.phaseTransition as InterviewPhase),
    profileUpdates,
    shouldConclude: input.shouldConclude,
  };
}

// ============================================
// Interview synthesis
// ============================================

export function validateSynthesisResult(input: unknown): SynthesisResult {
  if (!isRecord(input)) {
    fail('synthesis', 'root', 'must be an object');
  }
  if (!isStringArray(input.statedPreferences)) {
    fail('synthesis', 'statedPreferences', 'must be an array of strings');
  }
  if (!isStringArray(input.revealedPreferences)) {
    fail('synthesis', 'revealedPreferences', 'must be an array of strings');
  }
  if (!Array.isArray(input.themes)) {
    fail('synthesis', 'themes', 'must be an array');
  }
  if (input.themes.length > MAX_PROVIDER_LIST_ITEMS) {
    fail('synthesis', 'themes', `must contain at most ${MAX_PROVIDER_LIST_ITEMS} items`);
  }
  const themes: SynthesisTheme[] = input.themes.map((theme, i) => {
    if (!isRecord(theme)) {
      fail('synthesis', `themes[${i}]`, 'must be an object');
    }
    if (!isNonEmptyString(theme.theme)) {
      fail('synthesis', `themes[${i}].theme`, 'must be a non-empty string');
    }
    if (!isFiniteNonNegativeNumber(theme.frequency)) {
      fail('synthesis', `themes[${i}].frequency`, 'must be a finite non-negative number');
    }

    const hasLegacy = theme.evidence !== undefined;
    const hasRefs = theme.evidenceRefs !== undefined;
    if (hasLegacy === hasRefs) {
      fail('synthesis', `themes[${i}]`, 'must carry exactly one of evidence or evidenceRefs');
    }

    if (hasLegacy) {
      if (!isNonEmptyString(theme.evidence)) {
        fail('synthesis', `themes[${i}].evidence`, 'must be a non-empty string');
      }
      return {
        theme: theme.theme,
        evidence: theme.evidence,
        frequency: theme.frequency,
      };
    }

    if (!Array.isArray(theme.evidenceRefs) || theme.evidenceRefs.length > MAX_EVIDENCE_REFS) {
      fail('synthesis', `themes[${i}].evidenceRefs`, `must be an array of at most ${MAX_EVIDENCE_REFS} items`);
    }
    const evidenceRefs: EvidenceRef[] = theme.evidenceRefs.map((ref, j) => {
      if (!isRecord(ref)) {
        fail('synthesis', `themes[${i}].evidenceRefs[${j}]`, 'must be an object');
      }
      if (
        typeof ref.quote !== 'string'
        || ref.quote.length < 1
        || ref.quote.length > MAX_EVIDENCE_QUOTE
      ) {
        fail('synthesis', `themes[${i}].evidenceRefs[${j}].quote`, `must be a string with length between 1 and ${MAX_EVIDENCE_QUOTE}`);
      }
      if (!isPositiveInteger(ref.turnIndex)) {
        fail('synthesis', `themes[${i}].evidenceRefs[${j}].turnIndex`, 'must be an integer of at least 1');
      }
      if (ref.interviewId !== undefined && (typeof ref.interviewId !== 'string' || !INTERVIEW_ID.test(ref.interviewId))) {
        fail('synthesis', `themes[${i}].evidenceRefs[${j}].interviewId`, 'must be a valid id');
      }
      const knownKeys = new Set(['quote', 'turnIndex', 'interviewId']);
      if (Object.keys(ref).some((key) => !knownKeys.has(key))) {
        fail('synthesis', `themes[${i}].evidenceRefs[${j}]`, 'must not carry unknown fields');
      }
      const turnIndex = ref.turnIndex;
      return {
        quote: ref.quote,
        turnIndex,
        ...(ref.interviewId !== undefined ? { interviewId: ref.interviewId as string } : {}),
      };
    });
    return {
      theme: theme.theme,
      frequency: theme.frequency,
      evidenceRefs,
    };
  });
  if (!isStringArray(input.contradictions)) {
    fail('synthesis', 'contradictions', 'must be an array of strings');
  }
  if (!isStringArray(input.keyInsights)) {
    fail('synthesis', 'keyInsights', 'must be an array of strings');
  }
  if (!isNonEmptyString(input.bottomLine)) {
    fail('synthesis', 'bottomLine', 'must be a non-empty string');
  }
  return {
    statedPreferences: input.statedPreferences,
    revealedPreferences: input.revealedPreferences,
    themes,
    contradictions: input.contradictions,
    keyInsights: input.keyInsights,
    bottomLine: input.bottomLine,
  };
}

// ============================================
// Aggregate synthesis (cross-interview)
// ============================================

type AggregateCoreResult<TTheme> = {
  commonThemes: TTheme[];
  divergentViews: { topic: string; viewA: string; viewB: string }[];
  keyFindings: string[];
  researchImplications: string[];
  bottomLine: string;
};

/**
 * Shared body of both aggregate validators. `validateTheme` receives the
 * theme's already-checked `theme` name and `frequency`, plus the raw record,
 * and decides the evidence shape — a provider claim (interviewIndex) or a
 * resolved ref (interviewId). Everything else — divergentViews, keyFindings,
 * researchImplications, bottomLine, and every cap — is identical either way.
 */
function validateAggregateCore<TTheme>(
  input: unknown,
  validateTheme: (rawTheme: UnknownRecord, theme: string, frequency: number, i: number) => TTheme,
): AggregateCoreResult<TTheme> {
  if (!isRecord(input)) {
    fail('aggregate synthesis', 'root', 'must be an object');
  }
  if (!Array.isArray(input.commonThemes)) {
    fail('aggregate synthesis', 'commonThemes', 'must be an array');
  }
  if (input.commonThemes.length > MAX_PROVIDER_LIST_ITEMS) {
    fail('aggregate synthesis', 'commonThemes', `must contain at most ${MAX_PROVIDER_LIST_ITEMS} items`);
  }
  const commonThemes = input.commonThemes.map((rawTheme, i) => {
    if (!isRecord(rawTheme)) {
      fail('aggregate synthesis', `commonThemes[${i}]`, 'must be an object');
    }
    if (!isNonEmptyString(rawTheme.theme)) {
      fail('aggregate synthesis', `commonThemes[${i}].theme`, 'must be a non-empty string');
    }
    if (!isFiniteNonNegativeNumber(rawTheme.frequency)) {
      fail('aggregate synthesis', `commonThemes[${i}].frequency`, 'must be a finite non-negative number');
    }
    return validateTheme(rawTheme, rawTheme.theme, rawTheme.frequency, i);
  });

  if (!Array.isArray(input.divergentViews)) {
    fail('aggregate synthesis', 'divergentViews', 'must be an array');
  }
  if (input.divergentViews.length > MAX_PROVIDER_LIST_ITEMS) {
    fail('aggregate synthesis', 'divergentViews', `must contain at most ${MAX_PROVIDER_LIST_ITEMS} items`);
  }
  const divergentViews = input.divergentViews.map((view, i) => {
    if (!isRecord(view)) {
      fail('aggregate synthesis', `divergentViews[${i}]`, 'must be an object');
    }
    if (!isNonEmptyString(view.topic)) {
      fail('aggregate synthesis', `divergentViews[${i}].topic`, 'must be a non-empty string');
    }
    if (!isNonEmptyString(view.viewA)) {
      fail('aggregate synthesis', `divergentViews[${i}].viewA`, 'must be a non-empty string');
    }
    if (!isNonEmptyString(view.viewB)) {
      fail('aggregate synthesis', `divergentViews[${i}].viewB`, 'must be a non-empty string');
    }
    return { topic: view.topic, viewA: view.viewA, viewB: view.viewB };
  });

  if (!isStringArray(input.keyFindings)) {
    fail('aggregate synthesis', 'keyFindings', 'must be an array of strings');
  }
  if (!isStringArray(input.researchImplications)) {
    fail('aggregate synthesis', 'researchImplications', 'must be an array of strings');
  }
  if (!isNonEmptyString(input.bottomLine)) {
    fail('aggregate synthesis', 'bottomLine', 'must be a non-empty string');
  }
  return {
    commonThemes,
    divergentViews,
    keyFindings: input.keyFindings,
    researchImplications: input.researchImplications,
    bottomLine: input.bottomLine,
  };
}

/**
 * Validates what an AIProvider returns for an aggregate: quote *claims*,
 * positioned by `interviewIndex` into the prompt's catalogue, never named by
 * id. Called by the five adapters — keeps its name so no adapter import
 * changes (L3.2, L6.1).
 */
export function validateAggregateSynthesisPayload(input: unknown): AggregateSynthesisProviderPayload {
  return validateAggregateCore<AggregateThemeClaim>(input, (rawTheme, theme, frequency, i) => {
    if (rawTheme.representativeQuotes !== undefined) {
      fail('aggregate synthesis', `commonThemes[${i}]`, 'must not carry representativeQuotes');
    }
    if (!Array.isArray(rawTheme.quoteRefs) || rawTheme.quoteRefs.length > MAX_AGGREGATE_QUOTE_REFS) {
      fail('aggregate synthesis', `commonThemes[${i}].quoteRefs`, `must be an array of at most ${MAX_AGGREGATE_QUOTE_REFS} items`);
    }
    const quoteRefs: AggregateQuoteClaim[] = rawTheme.quoteRefs.map((claim, j) => {
      if (!isRecord(claim)) {
        fail('aggregate synthesis', `commonThemes[${i}].quoteRefs[${j}]`, 'must be an object');
      }
      if (
        typeof claim.quote !== 'string'
        || claim.quote.length < 1
        || claim.quote.length > MAX_EVIDENCE_QUOTE
      ) {
        fail('aggregate synthesis', `commonThemes[${i}].quoteRefs[${j}].quote`, `must be a string with length between 1 and ${MAX_EVIDENCE_QUOTE}`);
      }
      if (!isPositiveInteger(claim.turnIndex)) {
        fail('aggregate synthesis', `commonThemes[${i}].quoteRefs[${j}].turnIndex`, 'must be an integer of at least 1');
      }
      if (!isPositiveInteger(claim.interviewIndex) || claim.interviewIndex > MAX_AGGREGATE_INTERVIEW_INDEX) {
        fail('aggregate synthesis', `commonThemes[${i}].quoteRefs[${j}].interviewIndex`, `must be an integer between 1 and ${MAX_AGGREGATE_INTERVIEW_INDEX}`);
      }
      const knownKeys = new Set(['quote', 'turnIndex', 'interviewIndex']);
      if (Object.keys(claim).some((key) => !knownKeys.has(key))) {
        fail('aggregate synthesis', `commonThemes[${i}].quoteRefs[${j}]`, 'must not carry unknown fields');
      }
      return {
        quote: claim.quote,
        turnIndex: claim.turnIndex,
        interviewIndex: claim.interviewIndex,
      };
    });
    return { theme, frequency, quoteRefs };
  });
}

/**
 * Validates the aggregate the BROWSER posts back to generate-followup: by
 * then every surviving ref carries a server-resolved `interviewId`, never an
 * `interviewIndex`. Also accepts the legacy `representativeQuotes` shape —
 * the L2.7 rollout window, permanent, not transitional. Neither field or
 * both fields on the same theme is rejected.
 */
export function validateResolvedAggregateSynthesis(
  input: unknown
): Omit<AggregateSynthesisResult,
  'studyId' | 'studyRevision' | 'interviewIds' | 'interviewCount'
  | 'aiProvider' | 'aiModel' | 'requestedAiModel' | 'routedProvider'
  | 'generatedAt'
> {
  return validateAggregateCore<AggregateTheme>(input, (rawTheme, theme, frequency, i) => {
    const hasLegacy = rawTheme.representativeQuotes !== undefined;
    const hasRefs = rawTheme.quoteRefs !== undefined;
    if (hasLegacy === hasRefs) {
      fail('aggregate synthesis', `commonThemes[${i}]`, 'must carry exactly one of representativeQuotes or quoteRefs');
    }

    if (hasLegacy) {
      if (!isStringArray(rawTheme.representativeQuotes)) {
        fail('aggregate synthesis', `commonThemes[${i}].representativeQuotes`, 'must be an array of strings');
      }
      return { theme, frequency, representativeQuotes: rawTheme.representativeQuotes };
    }

    if (!Array.isArray(rawTheme.quoteRefs) || rawTheme.quoteRefs.length > MAX_AGGREGATE_QUOTE_REFS) {
      fail('aggregate synthesis', `commonThemes[${i}].quoteRefs`, `must be an array of at most ${MAX_AGGREGATE_QUOTE_REFS} items`);
    }
    const quoteRefs: EvidenceRef[] = rawTheme.quoteRefs.map((ref, j) => {
      if (!isRecord(ref)) {
        fail('aggregate synthesis', `commonThemes[${i}].quoteRefs[${j}]`, 'must be an object');
      }
      if (
        typeof ref.quote !== 'string'
        || ref.quote.length < 1
        || ref.quote.length > MAX_EVIDENCE_QUOTE
      ) {
        fail('aggregate synthesis', `commonThemes[${i}].quoteRefs[${j}].quote`, `must be a string with length between 1 and ${MAX_EVIDENCE_QUOTE}`);
      }
      if (!isPositiveInteger(ref.turnIndex)) {
        fail('aggregate synthesis', `commonThemes[${i}].quoteRefs[${j}].turnIndex`, 'must be an integer of at least 1');
      }
      if (typeof ref.interviewId !== 'string' || !INTERVIEW_ID.test(ref.interviewId)) {
        fail('aggregate synthesis', `commonThemes[${i}].quoteRefs[${j}].interviewId`, 'must be a valid id');
      }
      const knownKeys = new Set(['quote', 'turnIndex', 'interviewId']);
      if (Object.keys(ref).some((key) => !knownKeys.has(key))) {
        fail('aggregate synthesis', `commonThemes[${i}].quoteRefs[${j}]`, 'must not carry unknown fields');
      }
      return {
        quote: ref.quote,
        turnIndex: ref.turnIndex,
        interviewId: ref.interviewId,
      };
    });
    return { theme, frequency, quoteRefs };
  });
}

// ============================================
// Follow-up study
// ============================================

export interface FollowupStudy {
  name: string;
  researchQuestion: string;
  coreQuestions: string[];
}

export function validateFollowupStudy(input: unknown): FollowupStudy {
  if (!isRecord(input)) {
    fail('follow-up study', 'root', 'must be an object');
  }
  if (!isNonEmptyString(input.name)) {
    fail('follow-up study', 'name', 'must be a non-empty string');
  }
  if (!isNonEmptyString(input.researchQuestion)) {
    fail('follow-up study', 'researchQuestion', 'must be a non-empty string');
  }
  if (!isStringArray(input.coreQuestions, 50, 2_000) || input.coreQuestions.length === 0) {
    fail('follow-up study', 'coreQuestions', 'must be a non-empty array of strings');
  }
  return {
    name: input.name,
    researchQuestion: input.researchQuestion,
    coreQuestions: input.coreQuestions,
  };
}
