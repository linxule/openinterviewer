// @vitest-environment node
// The build must not fetch fonts from Google (next/font/google did, and CI
// builds failed when fonts.gstatic.com did not answer). The fonts are vendored
// in src/fonts; this keeps them complete and keeps next/font/google out.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const FONTS = path.join(ROOT, 'src/fonts');
const css = readFileSync(path.join(FONTS, 'fonts.css'), 'utf8');
const latin = readFileSync(path.join(FONTS, 'latin.ts'), 'utf8');
const FAMILIES = ['source-serif-4', 'public-sans', 'ibm-plex-mono'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [full] : [];
  });
}

function referenced(): string[] {
  const fromCss = [...css.matchAll(/url\(\.\/([^)]+)\)/g)].map((m) => m[1]);
  const fromLatin = [...latin.matchAll(/path: '\.\/([^']+)'/g)].map((m) => m[1]);
  return [...fromCss, ...fromLatin];
}

describe('self-hosted fonts', () => {
  it('never loads fonts from Google', () => {
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      // No next/font/google loader and no remote stylesheet or font url().
      expect(text, path.relative(ROOT, file)).not.toMatch(/['"]next\/font\/google['"]|url\(\s*['"]?(https?:)?\/\//);
    }
  });

  it('references exactly the vendored woff2 files, and ships each licence', () => {
    const vendored = FAMILIES.flatMap((family) => {
      expect(existsSync(path.join(FONTS, family, 'OFL.txt')), `${family}/OFL.txt`).toBe(true);
      return readdirSync(path.join(FONTS, family))
        .filter((name) => name.endsWith('.woff2'))
        .map((name) => `${family}/${name}`);
    });
    expect(new Set(referenced())).toEqual(new Set(vendored));
  });

  it('defines the families every consumer reads through --font-*', () => {
    const theme = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
    for (const [variable, family] of [
      ['serif', 'Source Serif 4'],
      ['sans', 'Public Sans'],
      ['mono', 'IBM Plex Mono'],
    ]) {
      expect(css).toContain(`--typeface-${variable}: '${family}', '${family} Fallback';`);
      expect(theme).toContain(`--font-${variable}: var(--typeface-${variable}),`);
      expect(css).toContain(`font-family: '${family} Fallback';`);
      expect(latin).toContain(`{ prop: 'font-family', value: "'${family}'" }`);
    }
  });
  it('draws CJK dashes and ellipses from a local CJK font on zh and ja content only', () => {
    const theme = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
    for (const [selector, face] of [[':lang(zh)', 'OI CJK Punctuation SC'], [':lang(ja)', 'OI CJK Punctuation JP']]) {
      const block = theme.slice(theme.indexOf(`${selector} {`), theme.indexOf('}', theme.indexOf(`${selector} {`)));
      for (const variable of ['sans', 'serif', 'mono']) {
        expect(block).toContain(`--font-${variable}: '${face}', var(--typeface-${variable}),`);
      }
      const faceRule = theme.slice(theme.indexOf(`font-family: '${face}';`));
      // Only the dash and ellipsis code points, and only fonts already on the device (no download).
      expect(faceRule.slice(0, faceRule.indexOf('}'))).toContain('unicode-range: U+2014-2015, U+2026;');
      expect(faceRule.slice(0, faceRule.indexOf('}'))).not.toContain('url(');
    }
  });
});
