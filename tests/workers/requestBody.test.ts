// readBoundedJsonObject in workerd: a chunked body without Content-Length is
// cancelled as soon as it passes the bound, and a fitting one still parses.
// The Node tier holds the full outcome matrix (tests/unit/requestBody.*).
import { describe, expect, it } from 'vitest';
import { readBoundedJsonObject } from '../../src/lib/requestBody';

const encoder = new TextEncoder();

function source(chunks: Uint8Array[]) {
  const state = { enqueued: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.enqueued >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[state.enqueued]);
      state.enqueued += 1;
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

describe('readBoundedJsonObject in the Workers runtime', () => {
  it('stops reading a chunked body without Content-Length once it exceeds the bound', async () => {
    const { stream, state } = source(Array.from({ length: 1_000 }, () => new Uint8Array(1_000).fill(0x20)));
    const request = new Request('https://workflow.example.test/api/test', { method: 'POST', body: stream });
    expect(request.headers.get('content-length')).toBeNull();

    await expect(readBoundedJsonObject(request, 10_000)).resolves.toEqual({ ok: false, status: 413 });
    // workerd may buffer a little ahead of the reader; it never drains the source.
    expect(state.enqueued).toBeLessThan(20);
    expect(state.enqueued).toBeGreaterThanOrEqual(11);
  });

  it('parses a chunked body that fits the bound', async () => {
    const text = JSON.stringify({ note: 'Synthetic — 主题 ✓', padding: 'p'.repeat(5_000) });
    const bytes = encoder.encode(text);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 997) chunks.push(bytes.slice(offset, offset + 997));
    const { stream } = source(chunks);
    const request = new Request('https://workflow.example.test/api/test', { method: 'POST', body: stream });
    await expect(readBoundedJsonObject(request, bytes.byteLength)).resolves.toEqual({ ok: true, value: JSON.parse(text) });
  });
});
