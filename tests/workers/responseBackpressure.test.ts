// The OpenNext response body used by the Worker (cloudflare/opennext/
// backpressureWrapper.ts) in workerd: a producer that honors write()/drain
// the way Next's pipe does stalls while the client does not read, resumes as
// it reads, and stops on cancel or error (ST-08 export memory).
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createBackpressuredBody, RESPONSE_QUEUE_HIGH_WATER_MARK } from '../../cloudflare/opennext/backpressureWrapper';

const CHUNK = 64 * 1024;
const CHUNKS = 64;

/** Writes like Next's createWriterFromResponse: await drain when write() returns false. */
function produce(writable: ReturnType<typeof createBackpressuredBody>['writable'], progress: { written: number }) {
  return (async () => {
    for (let index = 0; index < CHUNKS; index += 1) {
      const chunk = new Uint8Array(CHUNK).fill(index % 251);
      progress.written += 1;
      if (!writable.write(chunk)) await once(writable, 'drain');
    }
    writable.end();
  })();
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('backpressured OpenNext response body', () => {
  it('stalls the producer while the client does not read, then delivers every chunk in order', async () => {
    const { readable, writable } = createBackpressuredBody();
    const progress = { written: 0 };
    const producing = produce(writable, progress);
    await settle();
    const bufferedBytes = progress.written * CHUNK;
    // Response queue high-water mark + Node's Writable buffer + the chunk in flight.
    expect(bufferedBytes).toBeLessThanOrEqual(RESPONSE_QUEUE_HIGH_WATER_MARK + writable.writableHighWaterMark + 2 * CHUNK);
    expect(progress.written).toBeLessThan(CHUNKS);

    const reader = readable.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      expect(value.byteLength).toBe(CHUNK);
      expect(value[0]).toBe(received % 251);
      received += 1;
    }
    await producing;
    expect(received).toBe(CHUNKS);
  });

  it('a client that cancels stops the producer with an error instead of buffering the rest', async () => {
    const { readable, writable } = createBackpressuredBody();
    const errors: Error[] = [];
    writable.on('error', (error) => errors.push(error));
    const progress = { written: 0 };
    const producing = produce(writable, progress).catch((error: Error) => errors.push(error));
    await settle();
    const before = progress.written;
    await readable.cancel('client went away');
    await settle();
    await Promise.race([producing, settle()]);
    expect(errors.length).toBeGreaterThan(0);
    expect(progress.written).toBeLessThanOrEqual(before + 1);
  });

  it('a piped source that errors after the headers fails the body (OpenNext pipes its response object in)', async () => {
    const { readable, writable } = createBackpressuredBody();
    writable.on('error', () => {});
    const source = new PassThrough();
    source.on('error', () => {});
    source.pipe(writable);
    source.write(new Uint8Array(32));
    const reader = readable.getReader();
    expect((await reader.read()).value?.byteLength).toBe(32);
    source.destroy(new Error('route stream failed'));
    await expect(reader.read()).rejects.toThrow('route stream failed');
  });

  it('a piped source destroyed without an error still never ends the body cleanly', async () => {
    const { readable, writable } = createBackpressuredBody();
    writable.on('error', () => {});
    const source = new PassThrough();
    source.pipe(writable);
    source.write(new Uint8Array(8));
    source.destroy();
    const reader = readable.getReader();
    await expect((async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return 'clean end';
      }
    })()).rejects.toThrow('response source closed before the body ended');
  });

  it('a piped source that ends normally closes the body cleanly', async () => {
    const { readable, writable } = createBackpressuredBody();
    const source = new PassThrough();
    source.pipe(writable);
    source.end(new Uint8Array(8));
    const reader = readable.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    expect(bytes).toBe(8);
  });

  it('a producer error reaches the client as a failed body, never a clean end', async () => {
    const { readable, writable } = createBackpressuredBody();
    writable.on('error', () => {});
    writable.write(new Uint8Array(16));
    writable.destroy(new Error('export stream failed'));
    const reader = readable.getReader();
    await expect((async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return 'clean end';
      }
    })()).rejects.toThrow('export stream failed');
  });
});
