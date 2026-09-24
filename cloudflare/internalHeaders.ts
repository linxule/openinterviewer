// The reserved internal header namespace (RT-07). The Worker entry strips it
// from every incoming request before OpenNext, so no header a browser sends
// can pose as Worker-internal context. Kept apart from cloudflare/worker.ts,
// which imports the generated OpenNext bundle, so tests can load it unbuilt.

export const INTERNAL_HEADER_PREFIX = 'x-openinterviewer-internal-';

/** The request without any x-openinterviewer-internal-* header (names compare case-insensitively). */
export function withoutInternalHeaders(request: Request): Request {
  let reserved = false;
  for (const name of request.headers.keys()) {
    if (name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) {
      reserved = true;
      break;
    }
  }
  if (!reserved) return request;
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) headers.delete(name);
  }
  return new Request(request, { headers });
}
