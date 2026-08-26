import { defineConfig, globalIgnores } from 'eslint/config';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

// Design-law patterns banned outside src/components/ui/**. Each regex is matched
// against both plain string literals and template-literal chunks.
const designLawPatterns = [
  {
    regex: 'stone-',
    message:
      'Tailwind stone-* utilities are legacy. Use the paper/ink token scale — see docs/design/DIRECTION-final.md.',
  },
  {
    regex: '(amber|blue|cyan|emerald|fuchsia|gray|green|indigo|lime|neutral|orange|pink|purple|red|rose|sky|slate|teal|violet|yellow|zinc)-(50|[1-9]00|950)',
    message:
      'Tailwind default-palette utilities are banned. Use paper/ink/action/success/error — see docs/design/DIRECTION-final.md §2.',
  },
  {
    regex: '(text|bg|border|fill|stroke|placeholder|divide|ring|from|via|to)-(white|black)',
    message:
      'Absolute white/black is not in the palette. Use paper-*/ink-* — see docs/design/DIRECTION-final.md §2.',
  },
  {
    // Negative lookbehind excludes the `--font-serif` CSS custom-property name
    // (src/app/layout.tsx's next/font/google `variable` option, untouched by
    // G2) while still catching the raw Tailwind utility class.
    regex: '(?<!-)font-serif',
    primitivesOnly: true,
    message:
      'Raw font-serif is reserved for src/components/ui primitives — see docs/design/DIRECTION-final.md.',
  },
  {
    regex: 'var\\(--evidence',
    primitivesOnly: true,
    message:
      '--evidence is scoped to src/components/ui primitives, not general-purpose use — see docs/design/DIRECTION-final.md.',
  },
  {
    regex: 'var\\(--disclosure',
    primitivesOnly: true,
    message:
      '--disclosure is scoped to src/components/ui primitives, not general-purpose use — see docs/design/DIRECTION-final.md.',
  },
];

function restrictedSyntaxRules(patterns) {
  return patterns.flatMap(({ regex, message }) => [
    { selector: `Literal[value=/${regex}/]`, message },
    { selector: `TemplateElement[value.raw=/${regex}/]`, message },
  ]);
}

export default defineConfig([
  ...nextCoreWebVitals,
  {
    // Preserve the former Core Web Vitals lint scope. React Compiler adoption
    // and its stricter refactors should be a separate, deliberate change.
    rules: {
      'prefer-const': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
    },
  },
  {
    // Verbatim design law — DIRECTION-final.md §2 and §3. Every file under src/ is
    // covered; there is no exemption list. Exempting a file again means arguing for
    // it in a diff, not appending a line.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...restrictedSyntaxRules(designLawPatterns)],
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'framer-motion',
          message: 'Motion is two named gestures in CSS (settle, the trace) — see docs/design/DIRECTION-final.md §5.',
        }],
      }],
    },
  },
  {
    // The primitives are exactly where the scoped evidence/disclosure vars and
    // raw font-serif utility are meant to live; only stone-* and the general
    // palette bans stay enforced here.
    files: ['src/components/ui/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntaxRules(designLawPatterns.filter((p) => !p.primitivesOnly)),
      ],
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'dist/**',
    'next-env.d.ts',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
  ]),
]);
