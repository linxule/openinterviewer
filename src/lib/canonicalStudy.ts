// Canonical study resolution for participant-facing routes
// Authority (provider/model/prompts/study identity) always comes from the saved
// study record loaded server-side through the request's researcher KV context,
// never from request bodies. The participant token's studyId is authoritative;
// a legacy body studyConfig may carry only the study id, and solely for
// authenticated admin previews.

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { getStudy } from './kv';
import { StoredStudy } from '@/types';
import { validateStudyConfig } from './studyConfigValidation';

const STUDY_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

export type CanonicalStudyResult =
  | { ok: true; study: StoredStudy }
  | { ok: false; response: NextResponse };

export async function loadCanonicalStudy(opts: {
  kvClient: Redis;
  tokenStudyId?: string;
  legacyBodyStudyId?: string;
  isAdmin?: boolean;
}): Promise<CanonicalStudyResult> {
  // Token wins. The body id is accepted only for admin previews.
  const studyId = opts.tokenStudyId || (opts.isAdmin ? opts.legacyBodyStudyId : undefined);

  if (!studyId) {
    return { ok: false, response: NextResponse.json({ error: 'Missing study context' }, { status: 400 }) };
  }
  if (!STUDY_ID_PATTERN.test(studyId)) {
    return { ok: false, response: NextResponse.json({ error: 'Invalid study ID' }, { status: 400 }) };
  }

  try {
    const study = await getStudy(studyId, opts.kvClient);
    if (!study) {
      return { ok: false, response: NextResponse.json({ error: 'Study not found or no longer active' }, { status: 404 }) };
    }
    const validated = validateStudyConfig(study.config);
    if (
      !validated.ok
      || study.id !== studyId
      || study.config.id !== studyId
      || !Number.isSafeInteger(study.revision)
      || study.revision < 1
    ) {
      console.error('Canonical study record is malformed', { studyId });
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Study configuration is unavailable. Ask the researcher to review and save the study.' },
          { status: 503 }
        ),
      };
    }
    return { ok: true, study: { ...study, config: validated.config } };
  } catch (err) {
    console.error('Failed to load canonical study:', err);
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Study storage is temporarily unavailable. Please try again.', retryable: true },
        { status: 503 }
      ),
    };
  }
}
