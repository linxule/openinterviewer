// SQLite migration runner for the WorkspaceStore Durable Object (ST-09).
//
// Each numbered migration runs in its own transactionSync together with its
// ledger row, so an interrupted migration leaves neither partial schema nor a
// completion record, and the next object start retries it.
//
// Reader compatibility: a build serves a database only when every applied
// migration it does not know declares a `min_reader_version` at or below the
// build's own highest migration. That is what lets an N−1 build keep serving
// an N database (and N's pending jobs) during a rollback window; any other
// newer schema refuses readiness and every mutation.

import { MIGRATIONS, migrationChecksum, type Migration } from './schema';

export type SchemaRefusal = 'newer-incompatible' | 'checksum-mismatch' | 'ledger-gap';

export type SchemaOutcome =
  | { status: 'ready'; storedVersion: number; applied: number[] }
  | { status: 'schema-unsupported'; storedVersion: number; reason: SchemaRefusal };

type LedgerRow = { version: number; checksum: string; min_reader_version: number };

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  min_reader_version INTEGER NOT NULL CHECK (min_reader_version >= 1)
)`;

function minReaderOf(migration: Migration): number {
  return migration.minReaderVersion ?? migration.version;
}

/** Validate the stored ledger against this build, then apply its pending migrations in order. */
export function applyMigrations(
  storage: DurableObjectStorage,
  migrations: ReadonlyArray<Migration> = MIGRATIONS,
  now: number = Date.now(),
): SchemaOutcome {
  const sql = storage.sql;
  sql.exec(LEDGER_DDL);
  const ledger = sql
    .exec<LedgerRow>(`SELECT version, checksum, min_reader_version FROM schema_migrations ORDER BY version`)
    .toArray();
  const storedVersion = ledger.length > 0 ? ledger[ledger.length - 1].version : 0;
  const buildVersion = migrations.length > 0 ? migrations[migrations.length - 1].version : 0;

  for (const [index, row] of ledger.entries()) {
    if (row.version !== index + 1) return { status: 'schema-unsupported', storedVersion, reason: 'ledger-gap' };
    if (row.version > buildVersion) {
      if (row.min_reader_version > buildVersion) {
        return { status: 'schema-unsupported', storedVersion, reason: 'newer-incompatible' };
      }
      continue;
    }
    const known = migrations.find((migration) => migration.version === row.version);
    if (!known || migrationChecksum(known) !== row.checksum) {
      return { status: 'schema-unsupported', storedVersion, reason: 'checksum-mismatch' };
    }
  }

  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= storedVersion) continue;
    storage.transactionSync(() => {
      for (const statement of migration.statements) sql.exec(statement);
      sql.exec(
        `INSERT INTO schema_migrations (version, checksum, applied_at, min_reader_version) VALUES (?, ?, ?, ?)`,
        migration.version,
        migrationChecksum(migration),
        now,
        minReaderOf(migration),
      );
    });
    applied.push(migration.version);
  }
  return { status: 'ready', storedVersion: Math.max(storedVersion, buildVersion), applied };
}
