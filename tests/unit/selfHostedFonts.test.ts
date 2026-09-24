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
    for (const [variable, family] of [
      ['--font-serif', 'Source Serif 4'],
      ['--font-sans', 'Public Sans'],
      ['--font-mono', 'IBM Plex Mono'],
    ]) {
      expect(css).toContain(`${variable}: '${family}', '${family} Fallback';`);
      expect(css).toContain(`font-family: '${family} Fallback';`);
      expect(latin).toContain(`{ prop: 'font-family', value: "'${family}'" }`);
    }
  });
});
