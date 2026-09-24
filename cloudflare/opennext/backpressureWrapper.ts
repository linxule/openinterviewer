// OpenNext server wrapper for Workers with response backpressure.
//
// This is @opennextjs/aws 4.1.4 `overrides/wrappers/cloudflare-node` (the
// wrapper @opennextjs/cloudflare 1.20.6 configures) with one change: the
// Writable that Next writes the response into holds its callback while the
// Response body queue is full and releases it when workerd pulls. Upstream
// acknowledges every write immediately, so a streamed route handler (the
// researcher export) is drained into Worker memory as fast as it can produce,
// whatever the client's download speed. With the held callback, Node's
// Writable reports a full buffer, Next's pipe waits for `drain`, and the route
// stops pulling its own stream until the client reads.
//
// A second change: OpenNext `.pipe()`s its response object into this
// Writable, and Node's pipe does not forward a source error. When a route's
// stream fails after the headers, Next destroys that response object with the
// error; this Writable now errors the Response body too, so the client sees a
// failed transfer instead of a clean (truncated) end or a body left open.
//
// Everything else follows upstream: env strings copied to process.env for the
// adapter, null-body statuses, the localhost Content-Encoding workaround,
// abort signal propagation and waitUntil.

import { Writable } from 'node:stream';
import type { InternalEvent, InternalResult, StreamCreator } from '@opennextjs/aws/types/open-next.js';
import type { Wrapper, WrapperHandler } from '@opennextjs/aws/types/overrides.js';

/** Bytes the Response body may queue before Next is asked to wait. */
export const RESPONSE_QUEUE_HIGH_WATER_MARK = 256 * 1024;

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

type WorkerContext = { waitUntil(promise: Promise<unknown>): void };

function byteLength(chunk: unknown): number {
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  if (typeof chunk === 'string') return chunk.length;
  return 1;
}

/**
 * A Writable feeding a ReadableStream that the Response exposes. Writes are
 * acknowledged only while the readable's queue is below its high-water mark;
 * otherwise the callback waits for the next pull (or fails on cancel).
 */
export function createBackpressuredBody(highWaterMark = RESPONSE_QUEUE_HIGH_WATER_MARK): {
  readable: ReadableStream<Uint8Array>;
  writable: Writable;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pending: ((error?: Error | null) => void) | null = null;
  let cancelled: Error | null = null;
  const release = (error?: Error) => {
    const callback = pending;
    pending = null;
    callback?.(error ?? null);
  };
  const readable = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        release();
      },
      cancel() {
        cancelled = new Error('response body cancelled by the client');
        release(cancelled);
      },
    },
    { highWaterMark, size: byteLength },
  );
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      if (cancelled) return callback(cancelled);
      try {
        controller.enqueue(chunk);
      } catch (error) {
        return callback(error as Error);
      }
      if ((controller.desiredSize ?? 0) > 0) return callback();
      pending = callback;
    },
    final(callback) {
      try {
        controller.close();
      } catch {
        // Already closed or errored.
      }
      callback();
    },
    destroy(error, callback) {
      if (error) {
        try {
          controller.error(error);
        } catch {
          // Already closed or errored.
        }
      } else {
        try {
          controller.close();
        } catch {
          // Ignore "This ReadableStream is closed".
        }
      }
      release(error ?? undefined);
      callback(error);
    },
  });
  writable.on('pipe', (source: NodeJS.ReadableStream) => {
    source.once('error', (error: Error) => {
      if (!writable.destroyed) writable.destroy(error);
    });
    source.once('close', () => {
      if (!writable.writableEnded && !writable.destroyed) {
        writable.destroy(new Error('response source closed before the body ended'));
      }
    });
  });
  return { readable, writable };
}

const wrapper: WrapperHandler<InternalEvent, InternalResult> = async (handler, converter) =>
  async (request: Request, env: Record<string, unknown>, ctx: WorkerContext, abortSignal?: AbortSignal) => {
    globalThis.process = process;
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') process.env[key] = value;
    }
    const internalEvent = await converter.convertFrom(request);
    const url = new URL(request.url);
    let resolveResponse!: (response: Response) => void;
    const promiseResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const streamCreator: StreamCreator = {
      writeHeaders(prelude) {
        const { statusCode, cookies, headers } = prelude;
        const responseHeaders = new Headers(headers);
        for (const cookie of cookies) responseHeaders.append('Set-Cookie', cookie);
        // Upstream workaround for PPR with `wrangler dev` (workers-sdk#8004).
        if (url.hostname === 'localhost') responseHeaders.set('Content-Encoding', 'identity');
        if (NULL_BODY_STATUSES.has(statusCode)) {
          resolveResponse(new Response(null, { status: statusCode, headers: responseHeaders }));
          return new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          });
        }
        const { readable, writable } = createBackpressuredBody();
        resolveResponse(new Response(readable, { status: statusCode, headers: responseHeaders }));
        return writable;
      },
      abortSignal,
      retainChunks: false,
    };
    ctx.waitUntil(handler(internalEvent, { streamCreator, waitUntil: ctx.waitUntil.bind(ctx) }));
    return promiseResponse;
  };

const backpressureWrapper: Wrapper<InternalEvent, InternalResult> = {
  wrapper,
  name: 'cloudflare-node-backpressure',
  supportStreaming: true,
};

export default backpressureWrapper;
