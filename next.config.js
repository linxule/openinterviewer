/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: __dirname,
  },
  // A participant link's URL holds its code (RT-10). It is rendered by the
  // static /p route (src/app/p/page.tsx), so the client router's state, which
  // it sends in its Next-Url and Next-Router-State-Tree request headers, holds
  // no code (src/lib/participantLinkHandover.ts). The empty `code` query stops
  // Next from appending the source's :code to the rewritten URL, as it does
  // for any source parameter the destination does not use.
  async rewrites() {
    return [
      { source: '/p/:code', destination: '/p?code=' },
    ]
  },
  // Never send a participant link's URL as a Referer.
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
