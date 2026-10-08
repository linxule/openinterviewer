// @vitest-environment node
// Interview languages: the shared helpers, study validation, prompts and the
// participant dictionaries (lib/i18n/).

import { describe, expect, it } from 'vitest';
import { makeStudyConfig } from '../fixtures/models';
import {
  configForParticipantLanguage,
  consentTextFor,
  INTERVIEW_LANGUAGES,
  preferredStudyLanguage,
  resolveStudyLanguage,
  studyLanguages,
  thankYouTextFor,
} from '@/lib/i18n/languages';
import { MESSAGES, type Messages } from '@/lib/i18n/messages';
import { validateStudyConfig, validateStudyConfigForCreate, validateStudyConfigUpdate } from '@/lib/studyConfigValidation';
import { buildGreetingPrompt } from '@/lib/prompts/greeting';
import { buildInterviewSystemPrompt } from '@/lib/prompts/interview';
import { ANALYSIS_LANGUAGE_INSTRUCTION, buildAggregateSynthesisPrompt, buildSynthesisPrompt } from '@/lib/prompts/synthesis';
import { defaultConsentText } from '@/lib/consentText';
import { defaultThankYouText } from '@/lib/thankYouText';

const multilingual = makeStudyConfig({
  consentText: 'English consent.',
  thankYouText: 'English thanks.',
  interviewLanguages: ['en', 'ja', 'zh'],
  consentTextTranslations: { ja: '日本語の同意文。', zh: '中文知情同意书。' },
  thankYouTextTranslations: { ja: 'ありがとうございました。' },
});

describe('language helpers', () => {
  it('a study without the setting is English only, as before', () => {
    const legacy = makeStudyConfig();
    expect(studyLanguages(legacy)).toEqual(['en']);
    expect(resolveStudyLanguage(legacy, undefined)).toBe('en');
    expect(resolveStudyLanguage(legacy, 'ja')).toBeNull();
    expect(configForParticipantLanguage(legacy, 'en')).toBe(legacy);
  });

  it('resolves only an offered language and defaults to the first', () => {
    expect(resolveStudyLanguage(multilingual, undefined)).toBe('en');
    expect(resolveStudyLanguage(multilingual, 'zh')).toBe('zh');
    expect(resolveStudyLanguage(multilingual, 'ko')).toBeNull();
    expect(resolveStudyLanguage(multilingual, 'zh-Hans')).toBeNull();
  });

  it('picks the consent and thank-you text of each language', () => {
    expect(consentTextFor(multilingual, 'en')).toBe('English consent.');
    expect(consentTextFor(multilingual, 'ja')).toBe('日本語の同意文。');
    expect(thankYouTextFor(multilingual, 'ja')).toBe('ありがとうございました。');
    expect(thankYouTextFor(multilingual, 'zh')).toBeUndefined();
    expect(configForParticipantLanguage(multilingual, 'ja').interviewLanguages).toEqual(['ja']);
  });

  it('preselects the study language matching the browser, else the default', () => {
    expect(preferredStudyLanguage(multilingual, ['zh-TW', 'en'])).toBe('zh');
    expect(preferredStudyLanguage(multilingual, ['de-DE', 'ja-JP'])).toBe('ja');
    expect(preferredStudyLanguage(multilingual, ['de-DE'])).toBe('en');
  });
});

describe('study validation', () => {
  const valid = (overrides: Record<string, unknown>) => validateStudyConfig({ ...makeStudyConfig(), ...overrides });

  it('accepts one to six distinct languages with consent text for each language after the first', () => {
    expect(valid({ interviewLanguages: ['ja'] }).ok).toBe(true);
    expect(valid({ interviewLanguages: [...INTERVIEW_LANGUAGES], consentTextTranslations: { zh: 'a', fr: 'b', ja: 'c', ko: 'd', es: 'e' } }).ok).toBe(true);
    expect(valid({ interviewLanguages: ['en', 'ja'], consentTextTranslations: { ja: 'c' }, thankYouTextTranslations: { ja: 't' } }).ok).toBe(true);
  });

  it.each([
    [{ interviewLanguages: [] }],
    [{ interviewLanguages: ['en', 'en'] }],
    [{ interviewLanguages: ['de'] }],
    [{ interviewLanguages: 'en' }],
    [{ interviewLanguages: ['en', 'ja'] }],
    [{ interviewLanguages: ['en', 'ja'], consentTextTranslations: { ja: '   ' } }],
    [{ interviewLanguages: ['en', 'ja'], consentTextTranslations: { ja: 'c', en: 'x' } }],
    [{ interviewLanguages: ['en', 'ja'], consentTextTranslations: { ja: 'c' }, thankYouTextTranslations: { ko: 't' } }],
    [{ consentTextTranslations: { ja: 'c' } }],
  ])('refuses %o', (overrides) => {
    expect(valid(overrides).ok).toBe(false);
  });

  it('refuses an unfilled placeholder in a translation at save time only', () => {
    const config = { ...makeStudyConfig(), interviewLanguages: ['en', 'fr'], consentTextTranslations: { fr: 'Sujet : [sujet]' } };
    expect(validateStudyConfig(config).ok).toBe(true);
    expect(validateStudyConfigForCreate(config, { id: config.id, createdAt: config.createdAt }).ok).toBe(false);
  });

  it('an edit that sends empty translation maps clears them', () => {
    const current = { ...makeStudyConfig(), interviewLanguages: ['en', 'ja'] as const, consentTextTranslations: { ja: 'c' }, thankYouTextTranslations: { ja: 't' } };
    const result = validateStudyConfigUpdate(
      current as never,
      { interviewLanguages: ['en'], consentTextTranslations: {}, thankYouTextTranslations: {} },
      undefined,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.interviewLanguages).toEqual(['en']);
      expect(result.config).not.toHaveProperty('consentTextTranslations');
      expect(result.config).not.toHaveProperty('thankYouTextTranslations');
    }
  });
});

describe('prompts', () => {
  const progress = { questionsAsked: [], total: 1, currentPhase: 'background' as const, isComplete: false };

  it('tells the interviewer the participant\'s language, and leaves studies without the setting unchanged', () => {
    const legacy = makeStudyConfig();
    expect(buildInterviewSystemPrompt(legacy, null, progress, '')).not.toContain('INTERVIEW LANGUAGE');
    expect(buildGreetingPrompt(legacy)).not.toContain('INTERVIEW LANGUAGE');
    const japanese = configForParticipantLanguage(multilingual, 'ja');
    expect(buildInterviewSystemPrompt(japanese, null, progress, '')).toContain('INTERVIEW LANGUAGE: Japanese (日本語).');
    expect(buildGreetingPrompt(japanese)).toContain('Conduct the whole interview in Japanese');
  });

  it('asks for English analysis with untranslated quotations only when a study offers another language', () => {
    const behavior = { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] };
    expect(buildSynthesisPrompt([], makeStudyConfig(), behavior, null)).not.toContain(ANALYSIS_LANGUAGE_INSTRUCTION);
    expect(buildSynthesisPrompt([], makeStudyConfig({ interviewLanguages: ['en'] }), behavior, null)).not.toContain(ANALYSIS_LANGUAGE_INSTRUCTION);
    expect(buildSynthesisPrompt([], multilingual, behavior, null)).toContain(ANALYSIS_LANGUAGE_INSTRUCTION);
    expect(buildAggregateSynthesisPrompt(multilingual, [], 0)).toContain(ANALYSIS_LANGUAGE_INSTRUCTION);
  });
});

describe('participant dictionaries', () => {
  function leaves(value: unknown, path: string[] = []): Array<[string, unknown]> {
    if (typeof value === 'object' && value !== null) {
      return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]));
    }
    return [[path.join('.'), value]];
  }
  const sample = (entry: unknown): string => typeof entry === 'function'
    ? String((entry as (...args: unknown[]) => unknown)('Sample', 'Model X', 'Provider Y'))
    : String(entry);

  it('every language has every message, non-empty and without an unfilled placeholder', () => {
    const english = leaves(MESSAGES.en).map(([key]) => key).sort();
    for (const [language, messages] of Object.entries(MESSAGES) as Array<[string, Messages]>) {
      const entries = leaves(messages);
      expect(entries.map(([key]) => key).sort(), language).toEqual(english);
      for (const [key, entry] of entries) {
        const text = sample(entry);
        expect(text.trim().length, `${language}.${key}`).toBeGreaterThan(0);
        expect(text, `${language}.${key}`).not.toMatch(/\[[^\]]*\]|undefined|\$\{/);
      }
    }
  });

  it('every data notice names the provider, model and Cloudflare exactly as given', () => {
    for (const [language, messages] of Object.entries(MESSAGES) as Array<[string, Messages]>) {
      expect(messages.consent.transport.cloudflareGateway('Anthropic Claude'), language).toContain('Anthropic Claude');
      expect(messages.consent.transport.cloudflareGateway('Anthropic Claude'), language).toContain('Cloudflare');
      expect(messages.consent.commitment.fixed('Claude Sonnet 5.5', 'Anthropic Claude'), language).toContain('Claude Sonnet 5.5');
      expect(messages.consent.commitment.fixedOpenRouter('openai/gpt-x'), language).toContain('openai/gpt-x');
      expect(messages.consent.transport.vercelGateway('OpenAI'), language).toContain('Vercel AI Gateway');
    }
  });

  it('the generated default texts keep the research question and study name verbatim', () => {
    for (const language of INTERVIEW_LANGUAGES) {
      expect(defaultConsentText('  Why do people return?  ', language)).toContain('Why do people return?');
      expect(defaultThankYouText('Study Z', language)).toContain('Study Z');
    }
    expect(defaultConsentText('Q?')).toBe(MESSAGES.en.defaults.consentText('Q?'));
  });
});
