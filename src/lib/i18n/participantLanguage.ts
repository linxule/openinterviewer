import { NextResponse } from 'next/server';
import type { StudyConfig } from '@/types';
import { resolveStudyLanguage, type InterviewLanguage } from './languages';

export const LANGUAGE_NOT_OFFERED_CODE = 'LANGUAGE_NOT_OFFERED';

/**
 * The participant's language from a request body (`language`), checked
 * against the canonical study. Absent means the study's first language.
 */
export function participantLanguageFromBody(
  config: StudyConfig,
  body: Record<string, unknown>,
): { ok: true; language: InterviewLanguage } | { ok: false; response: NextResponse } {
  const language = resolveStudyLanguage(config, body.language);
  if (language) return { ok: true, language };
  return {
    ok: false,
    response: NextResponse.json(
      { error: 'This study is not offered in that language. Reopen the study link.', code: LANGUAGE_NOT_OFFERED_CODE },
      { status: 400 },
    ),
  };
}
