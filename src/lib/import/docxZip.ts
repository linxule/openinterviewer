import { crc32 } from '../export/zipStream';
import { fail, IMPORT_LIMITS as L, TranscriptImportError, utf8 } from './types';

type Entry = { name: string; start: number; compressed: number; expanded: number; crc: number; method: number };

/** Small, deliberately strict ZIP32 reader. Never inflate unrelated members. */
function directory(bytes: Uint8Array): Entry {
  if (bytes.length > L.fileBytes) fail('FILE_TOO_LARGE');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function range(at: number, size: number) {
    if (at < 0 || at + size > bytes.length) fail('MALFORMED_INPUT');
  }
  function u16(at: number) { range(at, 2); return view.getUint16(at, true); }
  function u32(at: number) { range(at, 4); return view.getUint32(at, true); }
  function extras(at: number, size: number) {
    const end = at + size;
    range(at, size);
    while (at < end) {
      if (at + 4 > end) fail('MALFORMED_INPUT');
      const id = u16(at);
      const length = u16(at + 2);
      // ZIP64 and path overrides introduce a second interpretation of identity.
      if (id === 1 || id === 0x7075) fail('UNSUPPORTED_FORMAT');
      at += 4 + length;
      if (at > end) fail('MALFORMED_INPUT');
    }
  }
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) fail('MALFORMED_INPUT');
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) fail('UNSUPPORTED_FORMAT');
  const count = u16(end + 10);
  if (count > L.archiveEntries) fail('ARCHIVE_LIMIT');
  const central = u32(end + 16);
  if (central + u32(end + 12) !== end) fail('MALFORMED_INPUT');
  let at = central;
  let total = 0;
  const names = new Set<string>();
  const ranges: [number, number][] = [];
  let document: Entry | undefined;
  for (let index = 0; index < count; index++) {
    range(at, 46);
    if (u32(at) !== 0x02014b50 || u16(at + 34)) fail('MALFORMED_INPUT');
    const flags = u16(at + 8);
    const method = u16(at + 10);
    if ((flags & ~0x080e) || (method !== 0 && method !== 8)) fail('UNSUPPORTED_FORMAT');
    const compressed = u32(at + 20);
    const expanded = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const next = at + 46 + nameLength + extraLength + u16(at + 32);
    if (next > end) fail('MALFORMED_INPUT');
    const name = utf8(bytes.subarray(at + 46, at + 46 + nameLength));
    if (!name || /[\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.includes(':')
      || name.split('/').some(part => part === '..' || part === '.') || names.has(name)) fail('UNSAFE_ARCHIVE');
    if (/\.(?:zip|docx|docm|xlsx|pptx|jar|7z|gz)$/i.test(name) || /(?:^|\/)embeddings\//i.test(name)
      || /vbaProject\.bin$/i.test(name) || ((u32(at + 38) >>> 16) & 0xf000) === 0xa000) fail('UNSAFE_ARCHIVE');
    names.add(name);
    total += expanded;
    if (total > L.archiveExpandedBytes || expanded > L.archiveExpandedBytes
      || expanded > Math.max(1, compressed) * L.expansionRatio) fail('ARCHIVE_LIMIT');
    extras(at + 46 + nameLength, extraLength);
    const local = u32(at + 42);
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) fail('MALFORMED_INPUT');
    const localNameLength = u16(local + 26);
    const localExtraLength = u16(local + 28);
    range(local + 30, localNameLength + localExtraLength);
    if (utf8(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) fail('MALFORMED_INPUT');
    extras(local + 30 + localNameLength, localExtraLength);
    const start = local + 30 + localNameLength + localExtraLength;
    let localEnd = start + compressed;
    if (localEnd > central) fail('MALFORMED_INPUT');
    const crc = u32(at + 16);
    if (flags & 8) {
      const descriptor = localEnd + (u32(localEnd) === 0x08074b50 ? 4 : 0);
      if (u32(descriptor) !== crc || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== expanded) fail('MALFORMED_INPUT');
      localEnd = descriptor + 12;
    } else if (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== expanded) fail('MALFORMED_INPUT');
    if (localEnd > central || (method === 0 && compressed !== expanded)) fail('MALFORMED_INPUT');
    ranges.push([local, localEnd]);
    if (name === 'word/document.xml') document = { name, start, compressed, expanded, method, crc };
    at = next;
  }
  if (at !== end) fail('MALFORMED_INPUT');
  ranges.sort((a, b) => a[0] - b[0]);
  let previousEnd = 0;
  for (const [start, stop] of ranges) {
    if (start !== previousEnd) fail('UNSAFE_ARCHIVE'); // overlaps, hidden local entries, executable preambles
    previousEnd = stop;
  }
  if (previousEnd !== central) fail('UNSAFE_ARCHIVE');
  if (!document) fail('MALFORMED_INPUT');
  if (document.expanded > L.documentBytes) fail('ARCHIVE_LIMIT');
  return document;
}

export async function documentXml(bytes: Uint8Array): Promise<string> {
  const entry = directory(bytes);
  const compressed = bytes.subarray(entry.start, entry.start + entry.compressed);
  let output: Uint8Array;
  if (entry.method === 0) output = compressed;
  else {
    // Small compressed chunks bound expansion between backpressure checks; never
    // hand an entire attacker-controlled compressed member to the inflater at once.
    let compressedOffset = 0;
    const source = new ReadableStream<BufferSource>({
      pull(controller) {
        if (compressedOffset === compressed.length) { controller.close(); return; }
        const next = Math.min(compressedOffset + 512, compressed.length);
        controller.enqueue(new Uint8Array(compressed.subarray(compressedOffset, next)));
        compressedOffset = next;
      },
    });
    const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > L.documentBytes || length > entry.expanded || length > Math.max(1, entry.compressed) * L.expansionRatio) fail('ARCHIVE_LIMIT');
        chunks.push(value);
      }
      output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof TranscriptImportError) throw error;
      return fail('MALFORMED_INPUT');
    } finally { reader.releaseLock(); }
  }
  if (output.length !== entry.expanded || crc32(output) !== entry.crc) fail('MALFORMED_INPUT');
  return utf8(output);
}
