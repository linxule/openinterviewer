import { defineConfig, globalIgnores } from 'eslint/config';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

// Verbatim migration ratchet — remove each file from this list as its slice migrates it.
const legacyDesignAllowlist = [
  'src/components/Export.tsx',
  'src/components/Login.tsx',
  'src/components/OAuthLogin.tsx',
  'src/app/layout.tsx',
  'src/app/self-host/page.tsx',
  // Not one of the 16 named screens, but a page.tsx the Hard Constraints forbid
  // touching, and it carries the same legacy stone-* loading/error markup as
  // self-host/page.tsx — the spec's allowlist omitted it.
  'src/app/**/setup/page.tsx',
  'src/app/p/\\[token\\]/page.tsx',
];

// Design-law patterns banned outside src/components/ui/**. Each regex is matched
// against both plain string literals and template-literal chunks.
const designLawPatterns = [
  {
    regex: 'stone-',
    message:
      'Tailwind stone-* utilities are legacy. Use the paper/ink token scale — see docs/design/DIRECTION-final.md.',
  },
  {
    regex: 'font-serif',
    message:
      'Raw font-serif is reserved for src/components/ui primitives — see docs/design/DIRECTION-final.md.',
  },
  {
    regex: 'var\\(--evidence',
    message:
      '--evidence is scoped to src/components/ui primitives, not general-purpose use — see docs/design/DIRECTION-final.md.',
  },
  {
    regex: 'var\\(--disclosure',
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
    // Verbatim migration ratchet — remove each file from this list as its slice migrates it.
    files: ['src/**/*.{ts,tsx}'],
    ignores: legacyDesignAllowlist,
    rules: {
      'no-restricted-syntax': ['error', ...restrictedSyntaxRules(designLawPatterns)],
    },
  },
  {
    // The primitives are exactly where the scoped evidence/disclosure vars and
    // raw font-serif utility are meant to live; only stone-* stays banned here.
    files: ['src/components/ui/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntaxRules(designLawPatterns.filter((p) => p.regex === 'stone-')),
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
