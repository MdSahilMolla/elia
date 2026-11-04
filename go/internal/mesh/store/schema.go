package store

// migrations are applied in order, each inside its own transaction. Forward-only:
// never edit a shipped migration, append a new one.
var migrations = []string{
	`CREATE TABLE meta (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE files (
		path        TEXT PRIMARY KEY,
		size        INTEGER NOT NULL,
		sha256      TEXT NOT NULL,
		version     INTEGER NOT NULL DEFAULT 1,
		last_writer TEXT,
		mtime_ns    INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE peers (
		peer_id      TEXT PRIMARY KEY,
		role         TEXT NOT NULL,
		cert_sha256  TEXT NOT NULL UNIQUE,
		display_name TEXT,
		joined_at    INTEGER NOT NULL,
		last_seen    INTEGER NOT NULL
	);

	CREATE TABLE pairing_codes (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		code_sha256 TEXT NOT NULL UNIQUE,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		max_uses   INTEGER NOT NULL DEFAULT 1,
		uses       INTEGER NOT NULL DEFAULT 0
	);

	CREATE INDEX files_sha256_idx ON files (sha256);
	CREATE INDEX peers_cert_idx ON peers (cert_sha256);`,

	// Phase 7. A conflict is recorded rather than resolved automatically: the
	// incoming version is preserved beside the local one and the user picks.
	// resolved_at is NULL for conflicts still awaiting a decision, which is what
	// the status command and the per-file resolution path filter on.
	`CREATE TABLE conflicts (
		id             INTEGER PRIMARY KEY AUTOINCREMENT,
		path           TEXT NOT NULL,
		kind           TEXT NOT NULL,
		base_version   INTEGER NOT NULL,
		local_version  INTEGER NOT NULL,
		remote_version INTEGER NOT NULL,
		local_hash     TEXT NOT NULL,
		remote_hash    TEXT NOT NULL,
		peer_id        TEXT NOT NULL DEFAULT '',
		kept_path      TEXT NOT NULL DEFAULT '',
		resolution     TEXT NOT NULL DEFAULT '',
		detected_at    INTEGER NOT NULL,
		resolved_at    INTEGER
	);

	CREATE INDEX conflicts_open_idx ON conflicts (resolved_at, detected_at);`,
}
