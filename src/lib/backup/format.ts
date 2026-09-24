// Operational backup format v1 (OPS-02, ST-10). Separate from the researcher
// ZIP export: it carries every authoritative WorkspaceStore record family so a
// quiesced workspace can be imported into a fresh isolated object.
//
// A backup is a sequence of JSON records, one per line:
//   {"kind":"chunk", family, index, watermark, sha256, rows}   (repeated)
//   {"kind":"manifest", manifest}
//   {"kind":"trailer", complete: true, manifestSha256}
// A file that stops before its manifest and trailer is visibly incomplete and
// is rejected. Rows are the exact SQL column values (JSON text columns stay
// the exact text written; absolute timestamps are copied, never renewed).
// There are no secrets in the workspace SQL (no API keys, session secrets,
// cookies or credential envelopes); the family list below is closed, and both
// the writer and the reader refuse any other family or column.
//
// Self-contained (no imports, erasable TypeScript only) so a Node operator
// script can load it with type stripping, and the Durable Object can share it.

export const BACKUP_FORMAT_VERSION = 1;
/** Rows per chunk the writer and importer accept. */
export const BACKUP_MAX_CHUNK_ROWS = 500;

export type BackupColumnType = 'text' | 'integer';
export type BackupColumn = { name: string; type: BackupColumnType; nullable: boolean };
export type BackupFamily = {
  name: string;
  /** Primary-key columns, in keyset paging order. */
  key: ReadonlyArray<string>;
  columns: ReadonlyArray<BackupColumn>;
};

function text(name: string, nullable = false): BackupColumn {
  return { name, type: 'text', nullable };
}

function integer(name: string, nullable = false): BackupColumn {
  return { name, type: 'integer', nullable };
}

/**
 * Every authoritative table of WorkspaceStore schema v1, in export/import
 * order (parents before children). `schema_migrations` travels as the
 * manifest's schemaVersion; `operator_audit` belongs to each object.
 */
export const BACKUP_FAMILIES: ReadonlyArray<BackupFamily> = Object.freeze([
  {
    name: 'workspace_meta',
    key: ['singleton'],
    columns: [
      integer('singleton'), text('workspace_id'), text('activated_epoch'), text('maintenance_state'),
      integer('maintenance_version'), integer('mutation_seq'), integer('created_at'), integer('updated_at'),
    ],
  },
  {
    name: 'studies',
    key: ['id'],
    columns: [
      text('id'), text('config_json'), integer('revision'), integer('created_at'), integer('updated_at'),
      integer('interview_count'), integer('is_locked'), integer('sample_fixture'),
    ],
  },
  {
    name: 'interviews',
    key: ['id'],
    columns: [
      text('id'), text('study_id'), text('record_json'), text('fingerprint'), integer('created_at'),
      integer('completed_at'), text('participant_session_id', true), text('link_id', true), integer('sample_fixture'),
      integer('study_revision', true),
    ],
  },
  {
    name: 'analysis',
    key: ['interview_id'],
    columns: [
      text('interview_id'), text('status'), integer('current_generation'), integer('attempts'),
      integer('last_attempt_at'), text('failure_kind', true), integer('recovery_required'),
      integer('study_revision', true), text('synthesis_json', true), text('provenance_json', true), integer('updated_at'),
    ],
  },
  {
    name: 'analysis_jobs',
    key: ['job_id'],
    columns: [
      text('job_id'), text('interview_id'), integer('generation'), text('recovery_epoch'), text('state'),
      text('input_json'), text('requested_provider'), text('requested_model'), integer('allocated_at'),
      integer('updated_at'), text('dispatch_state'), integer('dispatch_attempts'), integer('next_due_at', true),
      text('claim_nonce', true), integer('claimed_at', true), integer('claim_expires_at', true),
      integer('started_at', true), integer('terminal_at', true), text('failure_kind', true),
      text('terminal_receipt_json', true),
    ],
  },
  {
    name: 'aggregates',
    key: ['study_id'],
    columns: [text('study_id'), text('aggregate_json'), integer('saved_at')],
  },
  {
    name: 'participant_links',
    key: ['id'],
    columns: [
      text('id'), text('study_id'), integer('study_revision'), integer('created_at'),
      integer('expires_at', true), integer('revoked_at', true),
    ],
  },
  {
    name: 'consents',
    key: ['session_digest'],
    columns: [text('session_digest'), text('study_id'), text('record_json'), integer('expires_at')],
  },
  {
    name: 'idempotency_receipts',
    key: ['operation_family', 'key_digest'],
    columns: [
      text('operation_family'), text('key_digest'), text('fingerprint'), text('target_id', true),
      text('disposition'), text('result_json', true), integer('created_at'), integer('expires_at'),
    ],
  },
  {
    name: 'budget_windows',
    key: ['scope_key'],
    columns: [text('scope_key'), integer('count'), integer('window_seconds'), integer('expires_at')],
  },
  {
    name: 'budget_members',
    key: ['plan_key', 'member'],
    columns: [text('plan_key'), text('member'), integer('expires_at')],
  },
  {
    name: 'deletion_fences',
    key: ['kind', 'target_id'],
    columns: [text('kind'), text('target_id'), integer('deleted_at'), integer('expires_at'), integer('sample_fixture')],
  },
]);

export const BACKUP_FAMILY_NAMES: ReadonlyArray<string> = Object.freeze(BACKUP_FAMILIES.map((family) => family.name));

export function backupFamily(name: unknown): BackupFamily | null {
  return BACKUP_FAMILIES.find((family) => family.name === name) ?? null;
}

// ---------- Canonical JSON and checksums ----------

/** JSON with object keys sorted at every depth and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('value is not representable as JSON');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export async function sha256Hex(textValue: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(textValue));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A chunk's checksum: SHA-256 over the canonical JSON of its rows array. */
export function chunkChecksum(rows: ReadonlyArray<unknown>): Promise<string> {
  return sha256Hex(canonicalJson(rows));
}

// ---------- Row validation ----------

export type BackupErrorClass =
  | 'format-invalid'
  | 'format-unsupported'
  | 'family-unknown'
  | 'family-order'
  | 'row-invalid'
  | 'chunk-invalid'
  | 'chunk-missing'
  | 'chunk-unexpected'
  | 'checksum-mismatch'
  | 'count-mismatch'
  | 'watermark-changed'
  | 'identity-mismatch'
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'trailer-missing'
  | 'trailer-invalid'
  | 'record-after-trailer';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Closed column set and SQL type per value; integers must be safe. */
export function isValidBackupRow(family: BackupFamily, row: unknown): row is Record<string, string | number | null> {
  if (!isPlainObject(row)) return false;
  const keys = Object.keys(row);
  if (keys.length !== family.columns.length) return false;
  for (const column of family.columns) {
    if (!Object.prototype.hasOwnProperty.call(row, column.name)) return false;
    const value = row[column.name];
    if (value === null) {
      if (!column.nullable) return false;
      continue;
    }
    if (column.type === 'text' ? typeof value !== 'string' : !Number.isSafeInteger(value)) return false;
  }
  return true;
}

// ---------- Records ----------

export type BackupWatermark = { maintenanceVersion: number; mutationSeq: number };

export type BackupChunkDescriptor = { index: number; rows: number; sha256: string };

export type BackupManifest = {
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  schemaVersion: number;
  sourceWorkspaceId: string;
  exportedAt: number;
  watermark: BackupWatermark;
  families: Array<{ name: string; count: number; chunks: BackupChunkDescriptor[] }>;
};

export type BackupChunkRecord = {
  kind: 'chunk';
  family: string;
  index: number;
  watermark: BackupWatermark;
  sha256: string;
  rows: Array<Record<string, string | number | null>>;
};

export type BackupManifestRecord = { kind: 'manifest'; manifest: BackupManifest };
export type BackupTrailerRecord = { kind: 'trailer'; complete: true; manifestSha256: string };
export type BackupRecord = BackupChunkRecord | BackupManifestRecord | BackupTrailerRecord;

/**
 * What the WorkspaceStore import RPC binds to: the complete manifest, so the
 * import identity is the trailer's manifest digest and every chunk is checked
 * against its descriptor, plus the per-family counts.
 */
export type BackupImportManifest = BackupManifest & { counts: Record<string, number> };

function copyManifest(manifest: BackupManifest): BackupManifest {
  return {
    formatVersion: manifest.formatVersion,
    schemaVersion: manifest.schemaVersion,
    sourceWorkspaceId: manifest.sourceWorkspaceId,
    exportedAt: manifest.exportedAt,
    watermark: { maintenanceVersion: manifest.watermark.maintenanceVersion, mutationSeq: manifest.watermark.mutationSeq },
    families: manifest.families.map((family) => ({
      name: family.name,
      count: family.count,
      chunks: family.chunks.map((chunk) => ({ index: chunk.index, rows: chunk.rows, sha256: chunk.sha256 })),
    })),
  };
}

export function importManifestOf(manifest: BackupManifest): BackupImportManifest {
  const counts: Record<string, number> = {};
  for (const family of manifest.families) counts[family.name] = family.count;
  return { ...copyManifest(manifest), counts };
}

/**
 * The manifest an import request carries, validated: a complete v1 manifest
 * whose counts agree with its families. Returns exactly the manifest's own
 * members, so its digest equals the file trailer's manifestSha256.
 */
export function manifestFromImport(value: unknown): BackupManifest | null {
  if (!isPlainObject(value)) return null;
  const { counts, ...manifest } = value;
  if (!isValidBackupManifest(manifest) || !isPlainObject(counts)) return null;
  if (Object.keys(counts).length !== manifest.families.length) return null;
  if (!manifest.families.every((family) => counts[family.name] === family.count)) return null;
  return copyManifest(manifest);
}

/** SHA-256 over the canonical manifest: the trailer digest and the import identity. */
export function backupManifestDigest(manifest: BackupManifest): Promise<string> {
  return sha256Hex(canonicalJson(manifest));
}

/**
 * The workspace_meta chunk is the source's single metadata row, read under
 * the same watermark it carries.
 */
function metaChunkError(
  rows: ReadonlyArray<Record<string, unknown>>,
  watermark: BackupWatermark,
  sourceWorkspaceId: string | null,
): BackupErrorClass | null {
  if (rows.length !== 1) return 'chunk-invalid';
  const row = rows[0];
  if (row.maintenance_version !== watermark.maintenanceVersion || row.mutation_seq !== watermark.mutationSeq) {
    return 'watermark-changed';
  }
  if (sourceWorkspaceId !== null && row.workspace_id !== sourceWorkspaceId) return 'identity-mismatch';
  return null;
}

/** One line of the backup file (no trailing newline). */
export function encodeBackupRecord(record: BackupRecord): string {
  return JSON.stringify(record);
}

export function sameWatermark(a: BackupWatermark, b: BackupWatermark): boolean {
  return a.maintenanceVersion === b.maintenanceVersion && a.mutationSeq === b.mutationSeq;
}

function isWatermark(value: unknown): value is BackupWatermark {
  return isPlainObject(value)
    && Number.isSafeInteger(value.maintenanceVersion) && (value.maintenanceVersion as number) >= 0
    && Number.isSafeInteger(value.mutationSeq) && (value.mutationSeq as number) >= 0;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export class BackupFormatError extends Error {
  readonly errorClass: BackupErrorClass;

  constructor(errorClass: BackupErrorClass) {
    super(`backup ${errorClass}`);
    this.name = 'BackupFormatError';
    this.errorClass = errorClass;
  }
}

// ---------- Writer ----------

export type BackupWriterInput = {
  schemaVersion: number;
  sourceWorkspaceId: string;
  exportedAt: number;
  watermark: BackupWatermark;
};

/**
 * Accumulates chunk descriptors while an operator script pages the
 * workspace. Families must be written in BACKUP_FAMILIES order, each as
 * consecutive chunks. Every page's watermark must equal the first one.
 */
export class BackupWriter {
  private readonly input: BackupWriterInput;
  private readonly families = new Map<string, { count: number; chunks: BackupChunkDescriptor[] }>();
  private lastFamilyIndex = -1;
  private finished = false;

  constructor(input: BackupWriterInput) {
    if (!isWatermark(input.watermark)) throw new BackupFormatError('manifest-invalid');
    this.input = input;
  }

  async chunk(familyName: string, rows: ReadonlyArray<unknown>, watermark: BackupWatermark): Promise<BackupChunkRecord> {
    if (this.finished) throw new BackupFormatError('record-after-trailer');
    const family = backupFamily(familyName);
    if (!family) throw new BackupFormatError('family-unknown');
    if (!isWatermark(watermark) || !sameWatermark(watermark, this.input.watermark)) {
      throw new BackupFormatError('watermark-changed');
    }
    const familyIndex = BACKUP_FAMILIES.indexOf(family);
    if (familyIndex < this.lastFamilyIndex) throw new BackupFormatError('family-order');
    this.lastFamilyIndex = familyIndex;
    if (rows.length === 0 || rows.length > BACKUP_MAX_CHUNK_ROWS) throw new BackupFormatError('chunk-invalid');
    if (!rows.every((row) => isValidBackupRow(family, row))) throw new BackupFormatError('row-invalid');
    if (family.name === 'workspace_meta') {
      const metaError = metaChunkError(rows as ReadonlyArray<Record<string, unknown>>, this.input.watermark, this.input.sourceWorkspaceId);
      if (metaError) throw new BackupFormatError(metaError);
    }
    const entry = this.families.get(family.name) ?? { count: 0, chunks: [] };
    this.families.set(family.name, entry);
    const sha256 = await chunkChecksum(rows);
    const index = entry.chunks.length;
    entry.chunks.push({ index, rows: rows.length, sha256 });
    entry.count += rows.length;
    return {
      kind: 'chunk',
      family: family.name,
      index,
      watermark: { ...this.input.watermark },
      sha256,
      rows: rows as Array<Record<string, string | number | null>>,
    };
  }

  /** Manifest and completion trailer; write both after the last chunk. */
  async finish(): Promise<{ manifest: BackupManifestRecord; trailer: BackupTrailerRecord }> {
    if (this.finished) throw new BackupFormatError('record-after-trailer');
    this.finished = true;
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: this.input.schemaVersion,
      sourceWorkspaceId: this.input.sourceWorkspaceId,
      exportedAt: this.input.exportedAt,
      watermark: { ...this.input.watermark },
      families: BACKUP_FAMILIES.map((family) => {
        const entry = this.families.get(family.name) ?? { count: 0, chunks: [] };
        return { name: family.name, count: entry.count, chunks: entry.chunks };
      }),
    };
    return {
      manifest: { kind: 'manifest', manifest },
      trailer: { kind: 'trailer', complete: true, manifestSha256: await backupManifestDigest(manifest) },
    };
  }
}

// ---------- Reader / validator ----------

export type BackupValidation =
  | { status: 'valid'; manifest: BackupManifest; counts: Record<string, number> }
  | { status: 'rejected'; errorClass: BackupErrorClass; counts: { records: number; chunks: number; rows: number } };

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** A complete v1 manifest with a closed shape (no members beyond the format's). */
export function isValidBackupManifest(value: unknown): value is BackupManifest {
  if (!isPlainObject(value)) return false;
  if (!hasExactKeys(value, ['formatVersion', 'schemaVersion', 'sourceWorkspaceId', 'exportedAt', 'watermark', 'families'])) return false;
  if (value.formatVersion !== BACKUP_FORMAT_VERSION) return false;
  if (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 1) return false;
  if (typeof value.sourceWorkspaceId !== 'string' || value.sourceWorkspaceId.length === 0) return false;
  if (!Number.isSafeInteger(value.exportedAt) || !isWatermark(value.watermark)) return false;
  if (!hasExactKeys(value.watermark, ['maintenanceVersion', 'mutationSeq'])) return false;
  if (!Array.isArray(value.families) || value.families.length !== BACKUP_FAMILIES.length) return false;
  if (value.families[0]?.count !== 1) return false;
  return value.families.every((family: unknown, position: number) => {
    if (!isPlainObject(family) || !hasExactKeys(family, ['name', 'count', 'chunks'])) return false;
    if (family.name !== BACKUP_FAMILIES[position].name) return false;
    if (!Number.isSafeInteger(family.count) || (family.count as number) < 0 || !Array.isArray(family.chunks)) return false;
    let total = 0;
    const chunksValid = family.chunks.every((chunk: unknown, index: number) => {
      if (!isPlainObject(chunk) || !hasExactKeys(chunk, ['index', 'rows', 'sha256']) || chunk.index !== index) return false;
      if (!Number.isSafeInteger(chunk.rows) || (chunk.rows as number) < 1 || (chunk.rows as number) > BACKUP_MAX_CHUNK_ROWS) return false;
      if (typeof chunk.sha256 !== 'string' || !SHA256_HEX.test(chunk.sha256)) return false;
      total += chunk.rows as number;
      return true;
    });
    return chunksValid && total === family.count;
  });
}

/** Parses one line; malformed JSON is reported as format-invalid. */
export function parseBackupLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new BackupFormatError('format-invalid');
  }
}

/**
 * Incremental validator: feed every parsed record in file order, then call
 * finish(). Rejects a missing chunk/manifest/trailer, a count mismatch, a
 * changed watermark and any checksum failure. Reports counts and an error
 * class only, never record contents.
 */
export class BackupValidator {
  private records = 0;
  private chunkCount = 0;
  private rowCount = 0;
  private readonly seen = new Map<string, Array<{ rows: number; sha256: string }>>();
  private lastFamilyIndex = -1;
  private watermark: BackupWatermark | null = null;
  private metaWorkspaceId: unknown = null;
  private manifest: BackupManifest | null = null;
  private trailer = false;
  private failure: BackupErrorClass | null = null;

  private reject(errorClass: BackupErrorClass): BackupValidation {
    this.failure = this.failure ?? errorClass;
    return this.result();
  }

  private result(): BackupValidation {
    return {
      status: 'rejected',
      errorClass: this.failure ?? 'format-invalid',
      counts: { records: this.records, chunks: this.chunkCount, rows: this.rowCount },
    };
  }

  /** Returns a rejection as soon as one is certain, otherwise null. */
  async accept(record: unknown): Promise<BackupValidation | null> {
    if (this.failure) return this.result();
    this.records += 1;
    if (this.trailer) return this.reject('record-after-trailer');
    if (!isPlainObject(record)) return this.reject('format-invalid');
    if (record.kind === 'chunk') {
      if (this.manifest) return this.reject('chunk-unexpected');
      const family = backupFamily(record.family);
      if (!family) return this.reject('family-unknown');
      const familyIndex = BACKUP_FAMILIES.indexOf(family);
      if (familyIndex < this.lastFamilyIndex) return this.reject('family-order');
      this.lastFamilyIndex = familyIndex;
      if (!isWatermark(record.watermark)) return this.reject('chunk-invalid');
      if (this.watermark && !sameWatermark(this.watermark, record.watermark)) return this.reject('watermark-changed');
      this.watermark = record.watermark;
      const chunks = this.seen.get(family.name) ?? [];
      this.seen.set(family.name, chunks);
      if (!Number.isSafeInteger(record.index) || (record.index as number) < 0) return this.reject('chunk-invalid');
      if (record.index !== chunks.length) return this.reject((record.index as number) < chunks.length ? 'chunk-unexpected' : 'chunk-missing');
      const rows = record.rows;
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > BACKUP_MAX_CHUNK_ROWS) return this.reject('chunk-invalid');
      if (typeof record.sha256 !== 'string' || !SHA256_HEX.test(record.sha256)) return this.reject('chunk-invalid');
      if ((await chunkChecksum(rows)) !== record.sha256) return this.reject('checksum-mismatch');
      if (!rows.every((row) => isValidBackupRow(family, row))) return this.reject('row-invalid');
      if (family.name === 'workspace_meta') {
        const metaError = metaChunkError(rows as Array<Record<string, unknown>>, record.watermark, null);
        if (metaError) return this.reject(metaError);
        this.metaWorkspaceId = (rows[0] as Record<string, unknown>).workspace_id;
      }
      chunks.push({ rows: rows.length, sha256: record.sha256 });
      this.chunkCount += 1;
      this.rowCount += rows.length;
      return null;
    }
    if (record.kind === 'manifest') {
      if (this.manifest) return this.reject('manifest-invalid');
      if (!isValidBackupManifest(record.manifest)) {
        return this.reject(isPlainObject(record.manifest) && record.manifest.formatVersion !== BACKUP_FORMAT_VERSION
          ? 'format-unsupported'
          : 'manifest-invalid');
      }
      const manifest = record.manifest;
      if (this.watermark && !sameWatermark(this.watermark, manifest.watermark)) return this.reject('watermark-changed');
      if (this.metaWorkspaceId !== null && this.metaWorkspaceId !== manifest.sourceWorkspaceId) return this.reject('identity-mismatch');
      for (const family of manifest.families) {
        const chunks = this.seen.get(family.name) ?? [];
        if (chunks.length < family.chunks.length) return this.reject('chunk-missing');
        if (chunks.length > family.chunks.length) return this.reject('chunk-unexpected');
        const total = chunks.reduce((sum, chunk) => sum + chunk.rows, 0);
        if (total !== family.count) return this.reject('count-mismatch');
        for (const descriptor of family.chunks) {
          const actual = chunks[descriptor.index];
          if (actual.rows !== descriptor.rows) return this.reject('count-mismatch');
          if (actual.sha256 !== descriptor.sha256) return this.reject('checksum-mismatch');
        }
      }
      this.manifest = manifest;
      return null;
    }
    if (record.kind === 'trailer') {
      if (!this.manifest) return this.reject('manifest-missing');
      if (record.complete !== true || typeof record.manifestSha256 !== 'string') return this.reject('trailer-invalid');
      if ((await backupManifestDigest(this.manifest)) !== record.manifestSha256) return this.reject('checksum-mismatch');
      this.trailer = true;
      return null;
    }
    return this.reject('format-invalid');
  }

  finish(): BackupValidation {
    if (this.failure) return this.result();
    if (!this.manifest) return this.reject('manifest-missing');
    if (!this.trailer) return this.reject('trailer-missing');
    return { status: 'valid', manifest: this.manifest, counts: importManifestOf(this.manifest).counts };
  }
}

/** Validates a whole backup given its lines (sync or async iterable). */
export async function validateBackupLines(
  lines: Iterable<string> | AsyncIterable<string>,
): Promise<BackupValidation> {
  const validator = new BackupValidator();
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = parseBackupLine(line);
    } catch {
      record = null;
    }
    const rejected = await validator.accept(record);
    if (rejected) return rejected;
  }
  return validator.finish();
}
