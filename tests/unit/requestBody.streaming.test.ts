// readBoundedJsonObject reads the body incrementally: a body without
// Content-Length (chunked) is cancelled as soon as it passes the bound instead
// of being buffered whole, with the same 400/413 outcomes as before.
import { describe, expect, it } from 'vitest';
import { readBoundedJsonObject } from '@/lib/requestBody';

const encoder = new TextEncoder();

type Source = { stream: ReadableStream<Uint8Array>; state: { pulls: number; enqueued: number; cancelled: boolean } };

/** A pull-driven body that produces `chunks` on demand and records how far it was read. */
function source(chunks: Uint8Array[]): Source {
  const state = { pulls: 0, enqueued: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
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

function chunkedRequest(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  // Node requires duplex for a stream body; it sends no Content-Length.
  return new Request('http://localhost/api/test', { method: 'POST', body: stream, headers, duplex: 'half' } as RequestInit);
}

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) chunks.push(bytes.slice(offset, offset + size));
  return chunks;
}

describe('readBoundedJsonObject streaming bound', () => {
  it('cancels a chunked body without Content-Length as soon as it exceeds the bound', async () => {
    // 1,000 chunks of 1,000 bytes (1 MB) against a 10,000-byte bound.
    const { stream, state } = source(Array.from({ length: 1_000 }, () => new Uint8Array(1_000).fill(0x20)));
    const request = chunkedRequest(stream);
    expect(request.headers.get('content-length')).toBeNull();

    await expect(readBoundedJsonObject(request, 10_000)).resolves.toEqual({ ok: false, status: 413 });
    // The eleventh chunk crosses the bound; nothing after it is requested.
    expect(state.enqueued).toBe(11);
    expect(state.pulls).toBeLessThanOrEqual(12);
    expect(state.cancelled).toBe(true);
  });

  it('refuses a chunked body one byte over the bound and accepts one exactly at it', async () => {
    const value = { target: 'all', padding: '' };
    const exact = JSON.stringify({ ...value, padding: 'p'.repeat(100 - JSON.stringify(value).length) });
    expect(encoder.encode(exact).byteLength).toBe(100);

    const fits = source(split(encoder.encode(exact), 7));
    await expect(readBoundedJsonObject(chunkedRequest(fits.stream), 100)).resolves.toEqual({ ok: true, value: JSON.parse(exact) });
    expect(fits.state.cancelled).toBe(false);

    const over = source(split(encoder.encode(`${exact} `), 7));
    await expect(readBoundedJsonObject(chunkedRequest(over.stream), 100)).resolves.toEqual({ ok: false, status: 413 });
    expect(over.state.cancelled).toBe(true);
  });

  it('joins chunks that split multi-byte characters', async () => {
    const text = JSON.stringify({ note: 'Synthetic — 主题 ✓ é' });
    const { stream } = source(split(encoder.encode(text), 1));
    await expect(readBoundedJsonObject(chunkedRequest(stream), 1_000)).resolves.toEqual({ ok: true, value: JSON.parse(text) });
  });

  it('refuses a declared Content-Length over the bound without reading the body', async () => {
    const { stream, state } = source([encoder.encode('{}')]);
    const request = chunkedRequest(stream, { 'Content-Length': '1000' });
    await expect(readBoundedJsonObject(request, 100)).resolves.toEqual({ ok: false, status: 413 });
    expect(state.enqueued).toBe(0);
  });

  it('counts bytes actually sent when Content-Length understates them', async () => {
    const { stream, state } = source(Array.from({ length: 50 }, () => new Uint8Array(100).fill(0x20)));
    const request = chunkedRequest(stream, { 'Content-Length': '10' });
    await expect(readBoundedJsonObject(request, 1_000)).resolves.toEqual({ ok: false, status: 413 });
    expect(state.enqueued).toBeLessThanOrEqual(11);
  });

  it('keeps the decoded bound: invalid bytes that decode past it are refused as before', async () => {
    // 11 raw bytes; each 0xFF decodes to U+FFFD (3 bytes), 17 bytes decoded.
    const bytes = new Uint8Array([...encoder.encode('{"a":"'), 0xff, 0xff, 0xff, ...encoder.encode('"}')]);
    await expect(readBoundedJsonObject(new Request('http://localhost', { method: 'POST', body: bytes }), 12))
      .resolves.toEqual({ ok: false, status: 413 });
    await expect(readBoundedJsonObject(new Request('http://localhost', { method: 'POST', body: bytes }), 17))
      .resolves.toEqual({ ok: true, value: { a: '���' } });
  });

  it('answers 400 for a missing, unreadable, used or non-object body, as before', async () => {
    await expect(readBoundedJsonObject(new Request('http://localhost', { method: 'POST' }), 100))
      .resolves.toEqual({ ok: false, status: 400 });
    await expect(readBoundedJsonObject(new Request('http://localhost', { method: 'POST', body: '[1]' }), 100))
      .resolves.toEqual({ ok: false, status: 400 });
    await expect(readBoundedJsonObject(new Request('http://localhost', { method: 'POST', body: 'null' }), 100))
      .resolves.toEqual({ ok: false, status: 400 });
    await expect(readBoundedJsonObject(new Request('http://localhost', { method: 'POST', body: '{"a":' }), 100))
      .resolves.toEqual({ ok: false, status: 400 });

    const used = new Request('http://localhost', { method: 'POST', body: '{}' });
    await used.text();
    await expect(readBoundedJsonObject(used, 100)).resolves.toEqual({ ok: false, status: 400 });

    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":'));
        controller.error(new Error('synthetic client abort'));
      },
    });
    await expect(readBoundedJsonObject(chunkedRequest(failing), 100)).resolves.toEqual({ ok: false, status: 400 });
  });
});
