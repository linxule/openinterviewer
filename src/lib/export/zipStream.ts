// Streaming PKZIP writer (ST-08, RT-09). Web Streams only, so the same code
// runs in Node 24+ and workerd. Entries are deflated through
// CompressionStream('deflate-raw') and written with data descriptors, so
// memory is bounded by the entry being added plus the central-directory
// records (name + fixed fields per entry). The central directory is written
// only by finish(); abort() or any error errors the readable side instead, so
// a consumer never receives a well-formed archive that is missing entries.
//
// No ZIP64: an archive whose entry count, entry sizes, offsets or total size
// would need ZIP64 is refused with ZipLimitError rather than written corrupt.
//
// Self-contained (no imports, erasable TypeScript only) so a Node operator
// script can load it with type stripping.

export type ZipLimit = 'entries' | 'name-length' | 'entry-size' | 'archive-size';

export class ZipLimitError extends Error {
  readonly limit: ZipLimit;

  constructor(limit: ZipLimit) {
    super(`ZIP ${limit} limit exceeded`);
    this.name = 'ZipLimitError';
    this.limit = limit;
  }
}

export type ZipStreamLimits = {
  /** Maximum number of entries (files and directories). */
  maxEntries: number;
  /** Maximum uncompressed or compressed bytes of one entry. */
  maxEntryBytes: number;
  /** Maximum total archive bytes, central directory included. */
  maxArchiveBytes: number;
};

/** The classic (non-ZIP64) format's ceilings; 0xFFFF/0xFFFFFFFF are ZIP64 markers. */
export const ZIP32_LIMITS: Readonly<ZipStreamLimits> = Object.freeze({
  maxEntries: 0xfffe,
  maxEntryBytes: 0xfffffffe,
  maxArchiveBytes: 0xfffffffe,
});

export type ZipStreamOptions = {
  /** Modification time stamped on every entry (DOS time, UTC fields). Defaults to now. */
  modifiedAt?: Date;
  /** Tighter limits for tests or callers; each value is capped at ZIP32_LIMITS. */
  limits?: Partial<ZipStreamLimits>;
  /** Readable-side queue in bytes before writes wait for the consumer. */
  highWaterMarkBytes?: number;
};

export type ZipStream = {
  readonly readable: ReadableStream<Uint8Array>;
  addFile(name: string, data: string | Uint8Array): Promise<void>;
  addDirectory(name: string): Promise<void>;
  /** Writes the central directory and closes the stream. */
  finish(): Promise<void>;
  /** Errors the stream; no central directory is ever written afterwards. */
  abort(reason?: unknown): Promise<void>;
};

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const VERSION_DEFLATE = 20;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;

const LOCAL_HEADER_BYTES = 30;
const DATA_DESCRIPTOR_BYTES = 16;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const INPUT_SLICE_BYTES = 64 * 1024;
const MAX_NAME_BYTES = 0xffff;

let crcTable: Uint32Array | null = null;

function crc32Table(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 (IEEE 802.3), as PKZIP stores it. */
export function crc32(data: Uint8Array, previous = 0): number {
  const table = crc32Table();
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let index = 0; index < data.length; index += 1) {
    crc = table[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  const clampedYear = Math.min(year, 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((clampedYear - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

type CentralRecord = {
  name: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  externalAttributes: number;
};

function effectiveLimits(limits: Partial<ZipStreamLimits> | undefined): ZipStreamLimits {
  const pick = (key: keyof ZipStreamLimits): number => {
    const requested = limits?.[key];
    const ceiling = ZIP32_LIMITS[key];
    return typeof requested === 'number' && Number.isSafeInteger(requested) && requested >= 0
      ? Math.min(requested, ceiling)
      : ceiling;
  };
  return { maxEntries: pick('maxEntries'), maxEntryBytes: pick('maxEntryBytes'), maxArchiveBytes: pick('maxArchiveBytes') };
}

export function createZipStream(options: ZipStreamOptions = {}): ZipStream {
  const limits = effectiveLimits(options.limits);
  const stamp = dosDateTime(options.modifiedAt ?? new Date());
  const encoder = new TextEncoder();
  const highWaterMark = options.highWaterMarkBytes ?? 256 * 1024;
  const transform = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    undefined,
    new ByteLengthQueuingStrategy({ highWaterMark }),
  );
  const writer = transform.writable.getWriter();
  const central: CentralRecord[] = [];
  const names = new Set<string>();
  let offset = 0;
  let state: 'open' | 'busy' | 'finished' | 'failed' = 'open';

  async function emit(chunk: Uint8Array): Promise<void> {
    if (offset + chunk.length > limits.maxArchiveBytes) throw new ZipLimitError('archive-size');
    offset += chunk.length;
    await writer.write(chunk);
  }

  async function fail(reason: unknown): Promise<never> {
    state = 'failed';
    await writer.abort(reason).catch(() => undefined);
    throw reason;
  }

  function begin(): void {
    if (state === 'busy') throw new Error('ZIP entries must be added one at a time');
    if (state !== 'open') throw new Error('ZIP stream is no longer writable');
    state = 'busy';
  }

  function encodeName(name: string, directory: boolean): Uint8Array {
    if (name.length === 0 || name.startsWith('/') || name.includes('\\') || name.includes('\u0000')) {
      throw new TypeError('invalid ZIP entry name');
    }
    if (directory !== name.endsWith('/')) throw new TypeError('directory entries, and only they, end with /');
    if (names.has(name)) throw new TypeError('duplicate ZIP entry name');
    const bytes = encoder.encode(name);
    if (bytes.length > MAX_NAME_BYTES) throw new ZipLimitError('name-length');
    if (central.length + 1 > limits.maxEntries) throw new ZipLimitError('entries');
    names.add(name);
    return bytes;
  }

  function localHeader(record: Omit<CentralRecord, 'offset' | 'externalAttributes'>): Uint8Array {
    const bytes = new Uint8Array(LOCAL_HEADER_BYTES + record.name.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    view.setUint16(4, VERSION_DEFLATE, true);
    view.setUint16(6, record.flags, true);
    view.setUint16(8, record.method, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    // With the data-descriptor flag, CRC and sizes follow the data instead.
    view.setUint32(14, record.crc, true);
    view.setUint32(18, record.compressedSize, true);
    view.setUint32(22, record.uncompressedSize, true);
    view.setUint16(26, record.name.length, true);
    view.setUint16(28, 0, true);
    bytes.set(record.name, LOCAL_HEADER_BYTES);
    return bytes;
  }

  async function deflateInto(data: Uint8Array): Promise<number> {
    const compressor = new CompressionStream('deflate-raw');
    const input = compressor.writable.getWriter();
    const output = compressor.readable.getReader();
    let compressedSize = 0;
    const pump = (async () => {
      try {
        for (;;) {
          const next = await output.read();
          if (next.done) return;
          compressedSize += next.value.length;
          if (compressedSize > limits.maxEntryBytes) throw new ZipLimitError('entry-size');
          await emit(next.value);
        }
      } catch (error) {
        await input.abort(error).catch(() => undefined);
        await output.cancel(error).catch(() => undefined);
        throw error;
      }
    })();
    const feed = (async () => {
      for (let start = 0; start < data.length; start += INPUT_SLICE_BYTES) {
        await input.write(data.subarray(start, Math.min(start + INPUT_SLICE_BYTES, data.length)) as Uint8Array<ArrayBuffer>);
      }
      await input.close();
    })();
    await Promise.all([feed, pump]);
    return compressedSize;
  }

  async function addFile(name: string, data: string | Uint8Array): Promise<void> {
    begin();
    try {
      const nameBytes = encodeName(name, false);
      const bytes = typeof data === 'string' ? encoder.encode(data) : data;
      if (bytes.length > limits.maxEntryBytes) throw new ZipLimitError('entry-size');
      const entryOffset = offset;
      const flags = FLAG_DATA_DESCRIPTOR | FLAG_UTF8;
      await emit(localHeader({
        name: nameBytes,
        flags,
        method: METHOD_DEFLATE,
        crc: 0,
        compressedSize: 0,
        uncompressedSize: 0,
      }));
      const crc = crc32(bytes);
      const compressedSize = await deflateInto(bytes);
      const descriptor = new Uint8Array(DATA_DESCRIPTOR_BYTES);
      const view = new DataView(descriptor.buffer);
      view.setUint32(0, DATA_DESCRIPTOR_SIGNATURE, true);
      view.setUint32(4, crc, true);
      view.setUint32(8, compressedSize, true);
      view.setUint32(12, bytes.length, true);
      await emit(descriptor);
      central.push({
        name: nameBytes,
        flags,
        method: METHOD_DEFLATE,
        crc,
        compressedSize,
        uncompressedSize: bytes.length,
        offset: entryOffset,
        externalAttributes: 0,
      });
      state = 'open';
    } catch (error) {
      await fail(error);
    }
  }

  async function addDirectory(name: string): Promise<void> {
    begin();
    try {
      const nameBytes = encodeName(name, true);
      const entryOffset = offset;
      const record = { name: nameBytes, flags: FLAG_UTF8, method: METHOD_STORE, crc: 0, compressedSize: 0, uncompressedSize: 0 };
      await emit(localHeader(record));
      central.push({ ...record, offset: entryOffset, externalAttributes: DOS_DIRECTORY_ATTRIBUTE });
      state = 'open';
    } catch (error) {
      await fail(error);
    }
  }

  async function finish(): Promise<void> {
    begin();
    try {
      const directoryOffset = offset;
      let directorySize = 0;
      for (const record of central) directorySize += CENTRAL_HEADER_BYTES + record.name.length;
      if (directoryOffset + directorySize + END_OF_CENTRAL_DIRECTORY_BYTES > limits.maxArchiveBytes) {
        throw new ZipLimitError('archive-size');
      }
      for (const record of central) {
        const bytes = new Uint8Array(CENTRAL_HEADER_BYTES + record.name.length);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
        view.setUint16(4, VERSION_DEFLATE, true);
        view.setUint16(6, VERSION_DEFLATE, true);
        view.setUint16(8, record.flags, true);
        view.setUint16(10, record.method, true);
        view.setUint16(12, stamp.time, true);
        view.setUint16(14, stamp.date, true);
        view.setUint32(16, record.crc, true);
        view.setUint32(20, record.compressedSize, true);
        view.setUint32(24, record.uncompressedSize, true);
        view.setUint16(28, record.name.length, true);
        view.setUint16(30, 0, true);
        view.setUint16(32, 0, true);
        view.setUint16(34, 0, true);
        view.setUint16(36, 0, true);
        view.setUint32(38, record.externalAttributes, true);
        view.setUint32(42, record.offset, true);
        bytes.set(record.name, CENTRAL_HEADER_BYTES);
        await emit(bytes);
      }
      const end = new Uint8Array(END_OF_CENTRAL_DIRECTORY_BYTES);
      const view = new DataView(end.buffer);
      view.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
      view.setUint16(4, 0, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, central.length, true);
      view.setUint16(10, central.length, true);
      view.setUint32(12, directorySize, true);
      view.setUint32(16, directoryOffset, true);
      view.setUint16(20, 0, true);
      await emit(end);
      await writer.close();
      state = 'finished';
    } catch (error) {
      await fail(error);
    }
  }

  async function abort(reason?: unknown): Promise<void> {
    if (state === 'finished' || state === 'failed') return;
    state = 'failed';
    await writer.abort(reason ?? new Error('ZIP stream aborted')).catch(() => undefined);
  }

  return { readable: transform.readable, addFile, addDirectory, finish, abort };
}
