import { LANGUAGE_NATIVE_NAMES, LANGUAGE_TAGS, type InterviewLanguage } from '@/lib/i18n/languages';

/** One tab per offered language; renders nothing for a single-language study. */
export function LanguageTabs({ languages, selected, onSelect, label }: {
  languages: InterviewLanguage[];
  selected: InterviewLanguage;
  onSelect: (language: InterviewLanguage) => void;
  label: string;
}) {
  if (languages.length < 2) return null;
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-2 font-sans">
      {languages.map((language, index) => (
        <button
          key={language}
          type="button"
          role="tab"
          aria-selected={language === selected}
          lang={LANGUAGE_TAGS[language]}
          onClick={() => onSelect(language)}
          className={`rounded border px-3 py-1 text-[13px] ${language === selected ? 'border-ink-900 bg-paper-2 text-ink-900' : 'border-ink-300 text-ink-700 hover:bg-paper-2'}`}
        >
          {LANGUAGE_NATIVE_NAMES[language]}{index === 0 ? ' (default)' : ''}
        </button>
      ))}
    </div>
  );
}

/** The selected tab, falling back to the default when a language is removed. */
export function selectedLanguage(languages: InterviewLanguage[], selected: InterviewLanguage | null): InterviewLanguage {
  return selected && languages.includes(selected) ? selected : languages[0];
}
