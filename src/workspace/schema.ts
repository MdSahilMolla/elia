import type { Database } from 'bun:sqlite'

/**
 * Schema for `.elia/workspace.sqlite`.
 *
 * `workspace_events` is the append-only spine — nothing ever updates or deletes a
 * row there. Every other table is a projection the store rebuilds forward from
 * events and keeps current inside the same transaction that appends the event.
 * `audit_log` is an independent tamper-evident hash chain over every mutating
 * call, mirroring `src/battmann/store.ts`.
 *
 * Bump `PRAGMA user_version` and add an idempotent `ALTER`/`CREATE` below on any
 * change; never rewrite an existing statement.
 */
export const SCHEMA_VERSION = 3

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_events (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      id           TEXT NOT NULL UNIQUE,
      type         TEXT NOT NULL,
      objective_id TEXT,
      task_id      TEXT,
      actor_kind   TEXT NOT NULL,
      actor_id     TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON workspace_events(type);
    CREATE INDEX IF NOT EXISTS idx_events_objective ON workspace_events(objective_id);
    CREATE INDEX IF NOT EXISTS idx_events_task ON workspace_events(task_id);

    CREATE TABLE IF NOT EXISTS workspaces (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      default_project_id TEXT NOT NULL,
      created_at         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name         TEXT NOT NULL,
      repo_root    TEXT NOT NULL,
      branch       TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      role       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      removed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tokens (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      subject_id   TEXT NOT NULL,
      hash         TEXT NOT NULL UNIQUE,
      label        TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_subject ON tokens(subject_id);

    CREATE TABLE IF NOT EXISTS agent_identities (
      id                       TEXT PRIMARY KEY,
      name                     TEXT NOT NULL UNIQUE,
      role                     TEXT NOT NULL,
      path_scopes_json         TEXT NOT NULL,
      allowed_tools_json       TEXT NOT NULL,
      max_concurrent_tasks     INTEGER NOT NULL,
      can_merge_without_review INTEGER NOT NULL,
      created_at               TEXT NOT NULL,
      removed_at               TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id                TEXT PRIMARY KEY,
      identity_id       TEXT NOT NULL REFERENCES agent_identities(id),
      name              TEXT NOT NULL,
      role              TEXT NOT NULL,
      status            TEXT NOT NULL,
      current_task_id   TEXT,
      connection_id     TEXT,
      started_at        TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      stopped_at        TEXT,
      last_error        TEXT
    );

    CREATE TABLE IF NOT EXISTS objectives (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      project_id   TEXT NOT NULL REFERENCES projects(id),
      goal         TEXT NOT NULL,
      status       TEXT NOT NULL,
      run_id       TEXT NOT NULL,
      created_by   TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      approved_by  TEXT,
      approved_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id                    TEXT PRIMARY KEY,
      objective_id          TEXT NOT NULL REFERENCES objectives(id),
      project_id            TEXT NOT NULL REFERENCES projects(id),
      title                 TEXT NOT NULL,
      instructions          TEXT NOT NULL,
      role                  TEXT NOT NULL,
      status                TEXT NOT NULL,
      assignee_kind         TEXT,
      assignee_id           TEXT,
      depends_on_json       TEXT NOT NULL,
      files_json            TEXT NOT NULL,
      wave                  INTEGER,
      acceptance_json       TEXT NOT NULL,
      verification_json     TEXT NOT NULL,
      attempt_count         INTEGER NOT NULL,
      max_attempts          INTEGER NOT NULL,
      goal_node_id          TEXT,
      worktree_ref          TEXT,
      lease_owner           TEXT,
      lease_expires_at      INTEGER,
      created_by            TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      started_at            TEXT,
      finished_at           TEXT,
      last_error            TEXT,
      review_notes          TEXT,
      result_report         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_objective ON tasks(objective_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    -- tasks({ objectiveId, status }) -- the board view and the orchestrator's
    -- "what's ready under this objective" query -- filters both columns together.
    CREATE INDEX IF NOT EXISTS idx_tasks_objective_status ON tasks(objective_id, status);

    CREATE TABLE IF NOT EXISTS reservations (
      id          TEXT PRIMARY KEY,
      resource    TEXT NOT NULL,
      mode        TEXT NOT NULL,
      holder_kind TEXT NOT NULL,
      holder_id   TEXT NOT NULL,
      task_id     TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      released_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reservations_active ON reservations(released_at);
    -- reservations(true, { taskId }) -- buildContextPack's per-task lookup -- filters both columns together.
    CREATE INDEX IF NOT EXISTS idx_reservations_task_active ON reservations(task_id, released_at);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id           TEXT PRIMARY KEY,
      seq          INTEGER NOT NULL,
      objective_id TEXT,
      from_kind    TEXT NOT NULL,
      from_id      TEXT NOT NULL,
      to_id        TEXT,
      topic        TEXT NOT NULL,
      kind         TEXT NOT NULL,
      body         TEXT NOT NULL,
      refs_json    TEXT NOT NULL,
      at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_objective ON agent_messages(objective_id);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON agent_messages(to_id);
    -- messages() always ends in ORDER BY seq DESC LIMIT n, usually scoped to an
    -- objective -- without this it's a full scan + filesort on every poll.
    CREATE INDEX IF NOT EXISTS idx_messages_objective_seq ON agent_messages(objective_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_seq ON agent_messages(seq);

    CREATE TABLE IF NOT EXISTS decisions (
      id              TEXT PRIMARY KEY,
      objective_id    TEXT NOT NULL REFERENCES objectives(id),
      title           TEXT NOT NULL,
      detail          TEXT NOT NULL,
      decided_by_kind TEXT NOT NULL,
      decided_by_id   TEXT NOT NULL,
      at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_objective ON decisions(objective_id);

    CREATE TABLE IF NOT EXISTS approvals (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      subject      TEXT NOT NULL,
      objective_id TEXT,
      task_id      TEXT,
      status       TEXT NOT NULL,
      reason       TEXT,
      requested_at TEXT NOT NULL,
      resolved_by  TEXT,
      resolved_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

    CREATE TABLE IF NOT EXISTS presence (
      connection_id TEXT PRIMARY KEY,
      subject_kind  TEXT NOT NULL,
      subject_id    TEXT NOT NULL,
      name          TEXT NOT NULL,
      focus         TEXT,
      connected_at  TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      id         TEXT NOT NULL,
      action     TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id   TEXT NOT NULL,
      target     TEXT,
      payload_hash TEXT NOT NULL,
      prev_hash  TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)

  // Idempotent forward migrations for databases created by an earlier version.
  const addColumn = (tableName: string, column: string, definition: string): void => {
    const columns = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
    if (!columns.some((row) => row.name === column)) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column} ${definition}`)
  }
  addColumn('tasks', 'result_report', 'TEXT')

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
}
