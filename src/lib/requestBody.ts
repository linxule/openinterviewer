export type BoundedJsonObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413 };

/**
 * The body's bytes, or null once they exceed `maximumBytes`. The stream is
 * read chunk by chunk and cancelled as soon as the running total passes the
 * bound, so a body without Content-Length (chunked) is never buffered past it.
 * Throws when the body cannot be read (already used, aborted, not bytes).
 */
async function readBodyBytes(request: Request, maximumBytes: number): Promise<Uint8Array | null> {
  const body = request.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // ArrayBuffer.isView rather than instanceof: the stream may come from another realm.
      if (!ArrayBuffer.isView(value)) throw new TypeError('Request body chunk is not bytes');
      length += value.byteLength;
      if (length > maximumBytes) {
        reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Parses a JSON object body of at most `maximumBytes`: 413 when a declared
 * Content-Length or the bytes actually sent exceed it, 400 for an unreadable
 * body or anything but a JSON object.
 */
export async function readBoundedJsonObject(
  request: Request,
  maximumBytes: number
): Promise<BoundedJsonObjectResult> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return { ok: false, status: 413 };
  }

  try {
    const bytes = await readBodyBytes(request, maximumBytes);
    if (bytes === null) return { ok: false, status: 413 };
    // Decoded as Request.text() decodes (UTF-8, BOM stripped, invalid bytes
    // replaced). Replacement can grow the text, so the decoded length is
    // bounded too, as it was when the whole body was read with text().
    const text = new TextDecoder().decode(bytes);
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      return { ok: false, status: 413 };
    }
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, status: 400 };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400 };
  }
}
