// Numbered SQLite migrations for the WorkspaceStore Durable Object (ST-09).
// Rules: bound parameters only; additive changes; a migration is recorded only
// after its statements succeed inside the same transactionSync; unknown newer
// versions refuse service. Never edit a released migration: add a new one.

export type Migration = {
  version: number;
  name: string;
  statements: string[];
  /**
   * Oldest build, identified by its highest known migration, that may still
   * serve a database with this migration applied. Defaults to the migration's
   * own version, so older builds refuse it. Declare a lower value only for a
   * change older builds can ignore: new nullable or defaulted columns, or new
   * tables they never read. An N−1 build must keep serving N's pending jobs.
   * Not part of the checksum, which covers the statements only.
   */
  minReaderVersion?: number;
};

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: 'initial workspace schema',
    statements: [
      `CREATE TABLE workspace_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        workspace_id TEXT NOT NULL,
        activated_epoch TEXT NOT NULL,
        maintenance_state TEXT NOT NULL CHECK (maintenance_state IN ('open','draining','frozen','recovery')),
        maintenance_version INTEGER NOT NULL CHECK (maintenance_version >= 0),
        mutation_seq INTEGER NOT NULL CHECK (mutation_seq >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE studies (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        interview_count INTEGER NOT NULL CHECK (interview_count >= 0),
        is_locked INTEGER NOT NULL CHECK (is_locked IN (0, 1)),
        sample_fixture INTEGER NOT NULL DEFAULT 0 CHECK (sample_fixture IN (0, 1))
      )`,
      `CREATE INDEX studies_by_created ON studies (created_at, id)`,
      // study_revision is the record's own captured studyRevision, copied out
      // of record_json for aggregate eligibility; NULL for legacy records
      // without one (readers then fall back to the immutable record).
      `CREATE TABLE interviews (
        id TEXT PRIMARY KEY,
        study_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        participant_session_id TEXT,
        link_id TEXT,
        sample_fixture INTEGER NOT NULL DEFAULT 0 CHECK (sample_fixture IN (0, 1)),
        study_revision INTEGER
      )`,
      `CREATE INDEX interviews_by_study ON interviews (study_id, created_at, id)`,
      `CREATE INDEX interviews_by_created ON interviews (created_at, id)`,
      `CREATE TABLE analysis (
        interview_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending','running','complete','failed')),
        current_generation INTEGER NOT NULL CHECK (current_generation >= 0),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        last_attempt_at INTEGER NOT NULL,
        failure_kind TEXT,
        recovery_required INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)),
        study_revision INTEGER,
        synthesis_json TEXT,
        provenance_json TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE analysis_jobs (
        job_id TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        recovery_epoch TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','claimed','started','complete','failed','recovery-required','cancelled')),
        input_json TEXT NOT NULL,
        requested_provider TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        allocated_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('unsent','reserved','sent','none')),
        dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
        next_due_at INTEGER,
        claim_nonce TEXT,
        claimed_at INTEGER,
        claim_expires_at INTEGER,
        started_at INTEGER,
        terminal_at INTEGER,
        failure_kind TEXT,
        terminal_receipt_json TEXT,
        UNIQUE (interview_id, generation)
      )`,
      // One active generation per interview, enforced by the database as well
      // as by the allocation transaction (JOB-04).
      `CREATE UNIQUE INDEX analysis_jobs_one_active ON analysis_jobs (interview_id)
        WHERE state IN ('pending','claimed','started')`,
      `CREATE INDEX analysis_jobs_due ON analysis_jobs (next_due_at) WHERE next_due_at IS NOT NULL`,
      `CREATE INDEX analysis_jobs_terminal ON analysis_jobs (terminal_at) WHERE terminal_at IS NOT NULL`,
      `CREATE TABLE aggregates (
        study_id TEXT PRIMARY KEY,
        aggregate_json TEXT NOT NULL,
        saved_at INTEGER NOT NULL
      )`,
      `CREATE TABLE participant_links (
        id TEXT PRIMARY KEY,
        study_id TEXT NOT NULL,
        study_revision INTEGER NOT NULL CHECK (study_revision >= 1),
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER
      )`,
      `CREATE INDEX participant_links_by_study ON participant_links (study_id, created_at, id)`,
      `CREATE INDEX participant_links_by_expiry ON participant_links (expires_at) WHERE expires_at IS NOT NULL`,
      `CREATE TABLE consents (
        session_digest TEXT PRIMARY KEY,
        study_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE INDEX consents_by_expiry ON consents (expires_at)`,
      `CREATE INDEX consents_by_study ON consents (study_id)`,
      `CREATE TABLE idempotency_receipts (
        operation_family TEXT NOT NULL,
        key_digest TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        target_id TEXT,
        disposition TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (operation_family, key_digest)
      )`,
      `CREATE INDEX idempotency_receipts_by_expiry ON idempotency_receipts (expires_at)`,
      `CREATE INDEX idempotency_receipts_by_target ON idempotency_receipts (operation_family, target_id)`,
      // First-consumption windows (greeting/interview): the window opens at the
      // first successful charge and lasts window_seconds; it never slides.
      `CREATE TABLE budget_windows (
        scope_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL CHECK (count >= 0),
        window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
        expires_at INTEGER NOT NULL
      )`,
      `CREATE INDEX budget_windows_by_expiry ON budget_windows (expires_at)`,
      // Fixed epoch-aligned windows with idempotent membership (save admission).
      `CREATE TABLE budget_members (
        plan_key TEXT NOT NULL,
        member TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (plan_key, member)
      )`,
      `CREATE INDEX budget_members_by_expiry ON budget_members (expires_at)`,
      // Deleted targets stay fenced through the replay horizon: delayed
      // messages, replays and imports can never recreate them. A fence with
      // sample_fixture = 1 was written by sample-workspace clear; only a later
      // fixture seed may recreate those fixed ids.
      `CREATE TABLE deletion_fences (
        kind TEXT NOT NULL CHECK (kind IN ('study','interview')),
        target_id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        sample_fixture INTEGER NOT NULL DEFAULT 0 CHECK (sample_fixture IN (0, 1)),
        PRIMARY KEY (kind, target_id)
      )`,
      `CREATE INDEX deletion_fences_by_expiry ON deletion_fences (expires_at)`,
      `CREATE TABLE operator_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL
      )`,
      // Researcher sign-in attempt budget (gap F5): one row per salted client
      // digest plus one global row, each a fixed window opened by its first
      // counted attempt; `attempts` is failures plus attempts still being
      // verified (see login.ts). Per-object operational state like
      // operator_audit: excluded from operational backups and from the
      // research mutation sequence.
      `CREATE TABLE login_attempts (
        scope_key TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        expires_at INTEGER NOT NULL
      )`,
      `CREATE INDEX login_attempts_by_expiry ON login_attempts (expires_at)`,
    ],
  },
];

/** Highest schema version this build can read and write. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
/** Oldest stored schema version this build still reads (N−1 compatibility). */
export const MIN_READABLE_SCHEMA_VERSION = 1;

/** Stable checksum of a migration's statements (FNV-1a over the SQL text). */
export function migrationChecksum(migration: Migration): string {
  let hash = 0x811c9dc5;
  const text = migration.statements.join('\u0000');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, '0')}`;
}
