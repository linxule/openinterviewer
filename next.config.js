/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: __dirname,
  },
  // A participant link's URL holds its code: never send it as a Referer
  // (src/app/p/[token]/page.tsx; RT-10).
  async headers() {
    return [
      {
        source: '/p/:code*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ]
  },
}

module.exports = nextConfig
