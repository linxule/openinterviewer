// @vitest-environment node
// RT-07 wiring: the Worker entry hands OpenNext only the request with the
// reserved internal headers removed. The entry imports the generated OpenNext
// bundle, which no unbuilt tier can load (vitest cannot mock a missing
// module), and nothing downstream reads the namespace, so no runtime test can
// observe this call; it is checked in the source. The stripping itself runs in
// workerd in tests/workers/internalHeaders.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ENTRY = readFileSync(path.resolve(__dirname, '../../cloudflare/worker.ts'), 'utf8');

describe('Cloudflare Worker entry (RT-07)', () => {
  it('RT-07 passes OpenNext the request without internal headers, and nothing else', () => {
    expect(ENTRY).toContain("import { withoutInternalHeaders } from './internalHeaders';");
    // Every `.fetch(...)` call in the entry, with one level of nested parentheses.
    expect(ENTRY.match(/\.fetch\((?:[^()]|\([^()]*\))*\)/g)).toEqual(['.fetch(withoutInternalHeaders(request), env, ctx)']);
  });
});
