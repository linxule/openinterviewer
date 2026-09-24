import localFont from 'next/font/local'

// The preloaded latin faces; every other subset, the fallback faces and the
// --font-* variables are in ./fonts.css. The loader only emits hashed files,
// preload links and the @font-face rules below: `declarations` puts them in the
// families fonts.css names (the loader's own family, class and variable are
// unused), and the unicode-range is Google's latin subset. Font loader
// arguments must be literals, so the range is repeated.

export const sourceSerif4Latin = localFont({
  src: [
    { path: './source-serif-4/source-serif-4-italic-latin.woff2', weight: '400', style: 'italic' },
    { path: './source-serif-4/source-serif-4-italic-latin.woff2', weight: '600', style: 'italic' },
    { path: './source-serif-4/source-serif-4-normal-latin.woff2', weight: '400', style: 'normal' },
    { path: './source-serif-4/source-serif-4-normal-latin.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Source Serif 4'" },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
})

export const publicSansLatin = localFont({
  src: [
    { path: './public-sans/public-sans-latin.woff2', weight: '400', style: 'normal' },
    { path: './public-sans/public-sans-latin.woff2', weight: '500', style: 'normal' },
    { path: './public-sans/public-sans-latin.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Public Sans'" },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
})

export const ibmPlexMonoLatin = localFont({
  src: [
    { path: './ibm-plex-mono/ibm-plex-mono-400-latin.woff2', weight: '400', style: 'normal' },
    { path: './ibm-plex-mono/ibm-plex-mono-500-latin.woff2', weight: '500', style: 'normal' },
  ],
  display: 'swap',
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'IBM Plex Mono'" },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
})
