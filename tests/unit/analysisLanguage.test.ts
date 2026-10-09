import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';
import { WORKER_INVOCATION_ACCESSOR, type WorkerInvocation } from '@/lib/runtime/workerInvocation';
import { analysisLanguageSetting, installationAnalysisLanguage, parseAnalysisLanguage } from '@/lib/i18n/analysisLanguage';
import {
  ANALYSIS_LANGUAGE_INSTRUCTION,
  analysisLanguageBlock,
  buildAggregateSynthesisPrompt,
  buildSynthesisPrompt,
} from '@/lib/prompts/synthesis';

const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>;
const behavior = { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] };
const englishOnly = makeStudyConfig();
const multilingual = makeStudyConfig({ interviewLanguages: ['en', 'ja'], consentTextTranslations: { ja: '同意文。' } });

function inWorker(env: Record<string, unknown>, source: WorkerInvocation['source'] = 'queue') {
  runtimeGlobals[WORKER_INVOCATION_ACCESSOR] = () => ({ env, identity: null, source });
}

afterEach(() => {
  delete runtimeGlobals[WORKER_INVOCATION_ACCESSOR];
  vi.unstubAllEnvs();
});

describe('ANALYSIS_LANGUAGE', () => {
  it('is English when unset or empty, one of the six codes otherwise, and reports anything else as invalid', () => {
    expect(parseAnalysisLanguage(undefined)).toEqual({ ok: true, language: 'en', configured: false });
    expect(parseAnalysisLanguage('  ')).toEqual({ ok: true, language: 'en', configured: false });
    expect(parseAnalysisLanguage(' zh ')).toEqual({ ok: true, language: 'zh', configured: true });
    expect(parseAnalysisLanguage('de')).toEqual({ ok: false, value: 'de' });
    expect(parseAnalysisLanguage('zh-CN')).toEqual({ ok: false, value: 'zh-CN' });
  });

  it('reads process.env on Node and stays English for an invalid value', () => {
    vi.stubEnv('ANALYSIS_LANGUAGE', 'ko');
    expect(installationAnalysisLanguage()).toBe('ko');
    vi.stubEnv('ANALYSIS_LANGUAGE', 'klingon');
    expect(installationAnalysisLanguage()).toBe('en');
    expect(analysisLanguageSetting()).toEqual({ ok: false, value: 'klingon' });
  });

  it('reads the current Worker invocation, including the queue consumer whose process.env is not filled', () => {
    vi.stubEnv('ANALYSIS_LANGUAGE', 'fr');
    inWorker({ ANALYSIS_LANGUAGE: 'zh' }, 'queue');
    expect(installationAnalysisLanguage()).toBe('zh');
    inWorker({}, 'queue');
    expect(installationAnalysisLanguage()).toBe('en');
  });
});

describe('analysis prompts', () => {
  it('an English installation keeps the 5.1 prompts byte for byte', () => {
    const synthesis = buildSynthesisPrompt([], englishOnly, behavior, null);
    expect(synthesis).not.toContain('ANALYSIS LANGUAGE');
    expect(buildSynthesisPrompt([], multilingual, behavior, null)).toContain(ANALYSIS_LANGUAGE_INSTRUCTION);
    expect(analysisLanguageBlock(englishOnly, 'en')).toBe('');
  });

  it('another analysis language asks for every analysis field in it, for English-only studies too, with verbatim quotations', () => {
    vi.stubEnv('ANALYSIS_LANGUAGE', 'zh');
    for (const prompt of [
      buildSynthesisPrompt([], englishOnly, behavior, null),
      buildSynthesisPrompt([], multilingual, behavior, null),
      buildAggregateSynthesisPrompt(englishOnly, [], 0),
    ]) {
      expect(prompt).toContain('Write every analysis field (themes, preferences, contradictions, insights, findings, implications and summaries) in Simplified Chinese (Mandarin)');
      expect(prompt).toContain('Copy quotations exactly as written, in their original language; never translate them.');
      expect(prompt).not.toContain(ANALYSIS_LANGUAGE_INSTRUCTION);
    }
  });

  it('the queue consumer builds its prompt in the installation language', () => {
    inWorker({ ANALYSIS_LANGUAGE: 'es' }, 'queue');
    expect(buildSynthesisPrompt([], englishOnly, behavior, null)).toContain('in Spanish, whatever language the participants used');
  });
});

describe('study setup copy', () => {
  it('names the installation analysis language, and says when ANALYSIS_LANGUAGE is invalid', async () => {
    const { analysisLanguageNote } = await import('@/components/studySetup/InterviewLanguagesSection');
    expect(analysisLanguageNote('en', false)).toBe('Analysis is written in English (this installation’s analysis language), with quotations kept in the participant’s language.');
    expect(analysisLanguageNote('zh', false)).toContain('Analysis is written in Simplified Chinese (Mandarin)');
    expect(analysisLanguageNote('en', true)).toContain('ANALYSIS_LANGUAGE is not one of en, zh, fr, ja, ko or es');
  });
});
