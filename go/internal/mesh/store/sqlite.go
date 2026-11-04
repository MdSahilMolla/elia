// Package store owns the per-workspace SQLite state: metadata, tracked files,
// known peers and outstanding join codes.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // pure-Go driver, registered as "sqlite"
)

// StateDirName is the per-workspace control directory, created inside the root.
const StateDirName = ".workspace"

// DBFileName is the SQLite file inside StateDirName.
const DBFileName = "state.db"

// Store is a handle on one workspace's state database.
type Store struct {
	db   *sql.DB
	path string
}

// Open creates (or reuses) the state database for the workspace at root and
// brings its schema up to date.
func Open(root string) (*Store, error) {
	dir := filepath.Join(root, StateDirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}
	path := filepath.Join(dir, DBFileName)

	dsn := path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// A single writer avoids SQLITE_BUSY under concurrent access; readers are
	// still served in parallel by WAL.
	db.SetMaxOpenConns(1)

	s := &Store{db: db, path: path}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// DB exposes the raw handle for callers that need their own transaction.
func (s *Store) DB() *sql.DB { return s.db }

// Path is the absolute location of the database file.
func (s *Store) Path() string { return s.path }

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`); err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	var applied int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&applied); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}

	for i := applied; i < len(migrations); i++ {
		if err := s.applyOne(ctx, i+1, migrations[i]); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) applyOne(ctx context.Context, version int, script string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration %d: %w", version, err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, script); err != nil {
		return fmt.Errorf("apply migration %d: %w", version, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations (version) VALUES (?)`, version); err != nil {
		return fmt.Errorf("record migration %d: %w", version, err)
	}
	return tx.Commit()
}

// ErrNotFound is returned by the typed accessors when a row is absent.
var ErrNotFound = errors.New("not found")

// GetMeta reads a metadata value.
func (s *Store) GetMeta(key string) (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("meta %q: %w", key, ErrNotFound)
	}
	return v, err
}

// SetMeta writes a metadata value, replacing any existing one.
func (s *Store) SetMeta(key, value string) error {
	_, err := s.db.Exec(
		`INSERT INTO meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
