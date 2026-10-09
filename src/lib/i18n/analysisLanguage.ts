// The installation's analysis language (ANALYSIS_LANGUAGE): the language the
// researcher reads, and so the language of every model-written analysis
// field (per-interview synthesis and the cross-interview aggregate).
// Quotations stay verbatim in the participant's language. Unset or empty
// means English. On Cloudflare the value comes from the current invocation's
// env, which the analysis queue consumer has too (process.env is filled only
// on the fetch path); on Node from process.env.

import { currentWorkerInvocation } from '@/lib/runtime/workerInvocation';
import { DEFAULT_INTERVIEW_LANGUAGE, isInterviewLanguage, type InterviewLanguage } from './languages';

export type AnalysisLanguageSetting =
  | { ok: true; language: InterviewLanguage; configured: boolean }
  | { ok: false; value: string };

/** Parse a configured value: '' or absent is English; anything else must be one of the six codes. */
export function parseAnalysisLanguage(value: unknown): AnalysisLanguageSetting {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return { ok: true, language: DEFAULT_INTERVIEW_LANGUAGE, configured: false };
  return isInterviewLanguage(raw) ? { ok: true, language: raw, configured: true } : { ok: false, value: raw };
}

function configuredValue(): unknown {
  const invocation = currentWorkerInvocation();
  if (invocation) return invocation.env.ANALYSIS_LANGUAGE;
  return typeof process !== 'undefined' ? process.env.ANALYSIS_LANGUAGE : undefined;
}

/** The setting as configured, including an invalid value (for status and setup checks). */
export function analysisLanguageSetting(): AnalysisLanguageSetting {
  return parseAnalysisLanguage(configuredValue());
}

/**
 * The language analysis is written in. An invalid value is reported by the
 * setup checks and the researcher status; analysis then stays in English
 * rather than failing, since the language is a reading preference, not a
 * participant-facing promise.
 */
export function installationAnalysisLanguage(): InterviewLanguage {
  const setting = analysisLanguageSetting();
  return setting.ok ? setting.language : DEFAULT_INTERVIEW_LANGUAGE;
}
