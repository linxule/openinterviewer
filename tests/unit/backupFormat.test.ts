// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_FAMILIES,
  BACKUP_FAMILY_NAMES,
  BACKUP_MAX_CHUNK_ROWS,
  BackupFormatError,
  BackupWriter,
  backupManifestDigest,
  canonicalJson,
  chunkChecksum,
  encodeBackupRecord,
  importManifestOf,
  isValidBackupRow,
  manifestFromImport,
  sha256Hex,
  validateBackupLines,
  type BackupRecord,
  type BackupWatermark,
} from '@/lib/backup/format';

const WORKSPACE = `ws_${'a'.repeat(32)}`;
const EPOCH = `ep_${'b'.repeat(32)}`;
const WATERMARK: BackupWatermark = { maintenanceVersion: 3, mutationSeq: 41 };

const metaRow = {
  singleton: 1,
  workspace_id: WORKSPACE,
  activated_epoch: EPOCH,
  maintenance_state: 'frozen',
  maintenance_version: 3,
  mutation_seq: 41,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_500,
};

function studyRow(id: string) {
  return {
    id,
    config_json: JSON.stringify({ id, name: `Étude ${id} — 研究`, coreQuestions: [], profileSchema: [] }),
    revision: 2,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    interview_count: 0,
    is_locked: 0,
    sample_fixture: 0,
  };
}

function consentRow(index: number) {
  return {
    session_digest: `digest-${index}`,
    study_id: 'study-1',
    record_json: '{"acceptedAt":1700000000000}',
    // Already expired: backups copy absolute expiries, never renew them.
    expires_at: 1_600_000_000_000 + index,
  };
}

async function buildBackup(): Promise<{ records: BackupRecord[]; lines: string[] }> {
  const writer = new BackupWriter({ schemaVersion: 1, sourceWorkspaceId: WORKSPACE, exportedAt: 1_700_000_001_000, watermark: WATERMARK });
  const records: BackupRecord[] = [];
  records.push(await writer.chunk('workspace_meta', [metaRow], WATERMARK));
  records.push(await writer.chunk('studies', [studyRow('study-1'), studyRow('study-2')], WATERMARK));
  records.push(await writer.chunk('consents', [consentRow(1), consentRow(2)], WATERMARK));
  records.push(await writer.chunk('consents', [consentRow(3)], WATERMARK));
  const { manifest, trailer } = await writer.finish();
  records.push(manifest, trailer);
  return { records, lines: records.map(encodeBackupRecord) };
}

async function rechecksum(line: string, mutate: (record: Record<string, unknown>) => void): Promise<string> {
  const record = JSON.parse(line) as Record<string, unknown>;
  mutate(record);
  record.sha256 = await chunkChecksum(record.rows as unknown[]);
  return JSON.stringify(record);
}

describe('operational backup format v1 (OPS-02, ST-10)', () => {
  it('OPS-02: canonical JSON sorts keys at every depth and drops no values', () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }], e: {} })).toBe('{"a":[{"c":"x","d":null}],"b":1,"e":{}}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('OPS-02: a written backup validates, with counts per family and chunk checksums', async () => {
    const { lines, records } = await buildBackup();
    const result = await validateBackupLines(lines);
    expect(result.status).toBe('valid');
    if (result.status !== 'valid') return;
    expect(result.counts).toMatchObject({ workspace_meta: 1, studies: 2, consents: 3, interviews: 0 });
    expect(result.manifest.families.map((family) => family.name)).toEqual(BACKUP_FAMILY_NAMES);
    const consents = result.manifest.families.find((family) => family.name === 'consents')!;
    expect(consents.chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    const consentChunk = records[2];
    expect(consentChunk.kind === 'chunk' && consentChunk.sha256).toBe(await sha256Hex(canonicalJson([consentRow(1), consentRow(2)])));
    expect(importManifestOf(result.manifest)).toEqual({ ...result.manifest, counts: result.counts });
  });

  it('OPS-02: the import manifest carries the complete manifest; its identity is the trailer digest', async () => {
    const { records } = await buildBackup();
    const manifest = records.find((record) => record.kind === 'manifest')!;
    const trailer = records.find((record) => record.kind === 'trailer')!;
    if (manifest.kind !== 'manifest' || trailer.kind !== 'trailer') throw new Error('records');
    const presented = JSON.parse(JSON.stringify(importManifestOf(manifest.manifest))) as unknown;
    const bound = manifestFromImport(presented);
    expect(bound).toEqual(manifest.manifest);
    expect(await backupManifestDigest(bound!)).toBe(trailer.manifestSha256);

    const imported = importManifestOf(manifest.manifest);
    expect(manifestFromImport({ ...imported, counts: { ...imported.counts, consents: 4 } })).toBeNull();
    expect(manifestFromImport({ ...imported, extra: true })).toBeNull();
    const { families: _families, ...withoutFamilies } = imported;
    expect(manifestFromImport(withoutFamilies)).toBeNull();
    const { watermark: _watermark, ...withoutWatermark } = imported;
    expect(manifestFromImport(withoutWatermark)).toBeNull();
  });

  it('OPS-02: the workspace_meta chunk must be the source row read under the backup watermark', async () => {
    const { lines } = await buildBackup();
    const drifted = await rechecksum(lines[0], (record) => {
      (record.rows as Array<Record<string, unknown>>)[0].mutation_seq = 40;
    });
    expect(await validateBackupLines([drifted, ...lines.slice(1)])).toMatchObject({ status: 'rejected', errorClass: 'watermark-changed' });
    const otherSource = await rechecksum(lines[0], (record) => {
      (record.rows as Array<Record<string, unknown>>)[0].workspace_id = `ws_${'c'.repeat(32)}`;
    });
    expect(await validateBackupLines([otherSource, ...lines.slice(1)])).toMatchObject({ status: 'rejected', errorClass: 'identity-mismatch' });

    const writer = new BackupWriter({ schemaVersion: 1, sourceWorkspaceId: WORKSPACE, exportedAt: 1, watermark: WATERMARK });
    await expect(writer.chunk('workspace_meta', [{ ...metaRow, maintenance_version: 2 }], WATERMARK)).rejects.toMatchObject({ errorClass: 'watermark-changed' });
    await expect(writer.chunk('workspace_meta', [metaRow, metaRow], WATERMARK)).rejects.toMatchObject({ errorClass: 'chunk-invalid' });
    await expect(writer.chunk('workspace_meta', [{ ...metaRow, workspace_id: `ws_${'c'.repeat(32)}` }], WATERMARK))
      .rejects.toMatchObject({ errorClass: 'identity-mismatch' });
  });

  it('OPS-02: JSON types, Unicode and absolute (expired) lifetimes survive a file round trip', async () => {
    const { lines } = await buildBackup();
    const reread = lines.map((line) => JSON.parse(line) as BackupRecord);
    const consentChunk = reread[2];
    expect(consentChunk.kind === 'chunk' && consentChunk.rows).toEqual([consentRow(1), consentRow(2)]);
    const studies = reread[1];
    expect(studies.kind === 'chunk' && studies.rows[0].config_json).toContain('Étude study-1 — 研究');
  });

  it('OPS-02: rejects a missing trailer, missing manifest and a missing chunk', async () => {
    const { lines } = await buildBackup();
    expect(await validateBackupLines(lines.slice(0, -1))).toMatchObject({ status: 'rejected', errorClass: 'trailer-missing' });
    expect(await validateBackupLines(lines.slice(0, -2))).toMatchObject({ status: 'rejected', errorClass: 'manifest-missing' });
    const withoutFirstConsentChunk = [...lines.slice(0, 2), ...lines.slice(3)];
    expect(await validateBackupLines(withoutFirstConsentChunk)).toMatchObject({ status: 'rejected', errorClass: 'chunk-missing' });
    const withoutLastConsentChunk = [...lines.slice(0, 3), ...lines.slice(4)];
    expect(await validateBackupLines(withoutLastConsentChunk)).toMatchObject({ status: 'rejected', errorClass: 'chunk-missing' });
  });

  it('OPS-02: rejects a count mismatch, a changed watermark and checksum failures', async () => {
    const { lines } = await buildBackup();

    const shortChunk = await rechecksum(lines[3], (record) => {
      record.rows = [consentRow(3), consentRow(4)];
    });
    expect(await validateBackupLines([...lines.slice(0, 3), shortChunk, ...lines.slice(4)]))
      .toMatchObject({ status: 'rejected', errorClass: 'count-mismatch' });

    const moved = JSON.parse(lines[2]) as Record<string, unknown>;
    moved.watermark = { maintenanceVersion: 3, mutationSeq: 42 };
    expect(await validateBackupLines([lines[0], lines[1], JSON.stringify(moved), ...lines.slice(3)]))
      .toMatchObject({ status: 'rejected', errorClass: 'watermark-changed' });

    const tampered = JSON.parse(lines[1]) as { rows: Array<Record<string, unknown>> };
    tampered.rows[0].revision = 3;
    const result = await validateBackupLines([lines[0], JSON.stringify(tampered), ...lines.slice(2)]);
    expect(result).toMatchObject({ status: 'rejected', errorClass: 'checksum-mismatch' });
    // Counts and a class only: no record content in the rejection.
    expect(JSON.stringify(result)).not.toContain('study-1');

    const manifest = JSON.parse(lines[lines.length - 2]) as { manifest: { exportedAt: number } };
    manifest.manifest.exportedAt += 1;
    expect(await validateBackupLines([...lines.slice(0, -2), JSON.stringify(manifest), lines[lines.length - 1]]))
      .toMatchObject({ status: 'rejected', errorClass: 'checksum-mismatch' });
  });

  it('OPS-02: rejects unknown families, extra columns, unsafe integers and records after the trailer', async () => {
    const { lines } = await buildBackup();
    const secretFamily = await rechecksum(lines[1], (record) => {
      record.family = 'api_keys';
    });
    expect(await validateBackupLines([lines[0], secretFamily, ...lines.slice(2)]))
      .toMatchObject({ status: 'rejected', errorClass: 'family-unknown' });

    const extraColumn = await rechecksum(lines[1], (record) => {
      (record.rows as Array<Record<string, unknown>>)[0].session_cookie = 'x';
    });
    expect(await validateBackupLines([lines[0], extraColumn, ...lines.slice(2)]))
      .toMatchObject({ status: 'rejected', errorClass: 'row-invalid' });

    const unsafe = await rechecksum(lines[1], (record) => {
      (record.rows as Array<Record<string, unknown>>)[0].revision = 2 ** 53;
    });
    expect(await validateBackupLines([lines[0], unsafe, ...lines.slice(2)]))
      .toMatchObject({ status: 'rejected', errorClass: 'row-invalid' });

    expect(await validateBackupLines([...lines, lines[1]]))
      .toMatchObject({ status: 'rejected', errorClass: 'record-after-trailer' });
    expect(await validateBackupLines(['{not json', ...lines]))
      .toMatchObject({ status: 'rejected', errorClass: 'format-invalid' });
  });

  it('OPS-02: the writer refuses unknown families, invalid rows, oversized chunks, reordering and watermark drift', async () => {
    const writer = new BackupWriter({ schemaVersion: 1, sourceWorkspaceId: WORKSPACE, exportedAt: 1, watermark: WATERMARK });
    await expect(writer.chunk('credentials', [{}], WATERMARK)).rejects.toMatchObject({ errorClass: 'family-unknown' });
    await expect(writer.chunk('studies', [{ ...studyRow('s'), revision: '2' }], WATERMARK)).rejects.toMatchObject({ errorClass: 'row-invalid' });
    await expect(writer.chunk('studies', [studyRow('s')], { maintenanceVersion: 4, mutationSeq: 41 }))
      .rejects.toMatchObject({ errorClass: 'watermark-changed' });
    const tooMany = Array.from({ length: BACKUP_MAX_CHUNK_ROWS + 1 }, (_, index) => consentRow(index));
    await expect(writer.chunk('consents', tooMany, WATERMARK)).rejects.toMatchObject({ errorClass: 'chunk-invalid' });
    await writer.chunk('consents', [consentRow(1)], WATERMARK);
    await expect(writer.chunk('studies', [studyRow('s')], WATERMARK)).rejects.toBeInstanceOf(BackupFormatError);
  });

  it('OPS-02: the family list is closed and carries no secret, session or credential columns', () => {
    expect(BACKUP_FAMILY_NAMES).toEqual([
      'workspace_meta', 'studies', 'interviews', 'analysis', 'analysis_jobs', 'aggregates',
      'participant_links', 'consents', 'idempotency_receipts', 'budget_windows', 'budget_members', 'deletion_fences',
    ]);
    const columns = BACKUP_FAMILIES.flatMap((family) => family.columns.map((column) => column.name));
    for (const column of columns) {
      expect(column).not.toMatch(/secret|password|cookie|token|credential|api_?key|envelope/i);
    }
    expect(isValidBackupRow(BACKUP_FAMILIES[0], { ...metaRow, api_key: 'x' })).toBe(false);
  });

  it('OPS-02: the format module loads in plain Node for the operator CLI (type stripping, no imports)', () => {
    const modulePath = fileURLToPath(new URL('../../src/lib/backup/format.ts', import.meta.url));
    const output = execFileSync(process.execPath, [
      '--no-warnings',
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(modulePath)}); console.log(m.BACKUP_FAMILY_NAMES.length, typeof m.BackupWriter, typeof m.validateBackupLines);`,
    ], { encoding: 'utf8' });
    expect(output.trim()).toBe(`${BACKUP_FAMILY_NAMES.length} function function`);
  });
});
