package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Conflict kinds, mirroring versioning.ConflictVersion and friends. They are
// duplicated as plain strings because the store must not depend on a higher
// layer to name its own rows.
const (
	// ConflictBothEdited means both peers changed a file from the same base.
	ConflictBothEdited = "both-edited"
	// ConflictDeleteEdit means one peer deleted what the other edited.
	ConflictDeleteEdit = "delete-edit"
	// ConflictRemoteNewer means the remote change did not apply to the base the
	// sender expected, and the local file is untouched since.
	ConflictRemoteNewer = "version"
)

// ConflictKinds lists every kind a conflict row can carry.
//
// It exists so a higher layer can check that the kind it is about to write is
// one the store will later be able to filter and display. A kind invented
// upstream would still be stored, and then be invisible to anything reading the
// table by kind.
func ConflictKinds() []string {
	return []string{ConflictBothEdited, ConflictDeleteEdit, ConflictRemoteNewer}
}

// ValidConflictKind reports whether a kind is one the store recognises.
func ValidConflictKind(kind string) bool {
	for _, k := range ConflictKinds() {
		if k == kind {
			return true
		}
	}
	return false
}

// ConflictRow is one detected divergence, preserved until the user decides.
type ConflictRow struct {
	ID            int64
	Path          string
	Kind          string
	BaseVersion   int64
	LocalVersion  int64
	RemoteVersion int64
	LocalHash     string
	RemoteHash    string
	PeerID        string
	// KeptPath is where the incoming version was written, so nothing the remote
	// sent is lost even if the local file is later overwritten by hand.
	KeptPath   string
	Resolution string
	DetectedAt time.Time
	ResolvedAt time.Time
	// Resolved reports whether the user has decided this one.
	Resolved bool
}

// RecordConflict stores a divergence. A conflict is not an error state for the
// store: the file was already preserved on disk by the time this is called, and
// the row exists so the user can find out what happened and decide.
func (s *Store) RecordConflict(c ConflictRow) (int64, error) {
	res, err := s.db.Exec(`
		INSERT INTO conflicts (path, kind, base_version, local_version, remote_version,
		                       local_hash, remote_hash, peer_id, kept_path, resolution,
		                       detected_at, resolved_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.Path, c.Kind, c.BaseVersion, c.LocalVersion, c.RemoteVersion,
		c.LocalHash, c.RemoteHash, c.PeerID, c.KeptPath, c.Resolution,
		c.DetectedAt.UTC().Unix(), nullableUnix(c.ResolvedAt))
	if err != nil {
		return 0, fmt.Errorf("record conflict on %s: %w", c.Path, err)
	}
	return res.LastInsertId()
}

func nullableUnix(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Unix()
}

// UnresolvedConflicts lists conflicts still awaiting a decision, newest first.
func (s *Store) UnresolvedConflicts() ([]ConflictRow, error) {
	return s.queryConflicts(`WHERE resolved_at IS NULL ORDER BY detected_at DESC, id DESC`)
}

// AllConflicts lists every conflict, resolved or not, newest first.
func (s *Store) AllConflicts() ([]ConflictRow, error) {
	return s.queryConflicts(`ORDER BY detected_at DESC, id DESC`)
}

func (s *Store) queryConflicts(where string) ([]ConflictRow, error) {
	rows, err := s.db.Query(`
		SELECT id, path, kind, base_version, local_version, remote_version,
		       local_hash, remote_hash, peer_id, kept_path, resolution,
		       detected_at, resolved_at
		FROM conflicts ` + where)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ConflictRow
	for rows.Next() {
		var (
			c        ConflictRow
			detected int64
			resolved sql.NullInt64
		)
		if err := rows.Scan(&c.ID, &c.Path, &c.Kind, &c.BaseVersion, &c.LocalVersion,
			&c.RemoteVersion, &c.LocalHash, &c.RemoteHash, &c.PeerID, &c.KeptPath,
			&c.Resolution, &detected, &resolved); err != nil {
			return nil, err
		}
		c.DetectedAt = time.Unix(detected, 0).UTC()
		if resolved.Valid {
			c.ResolvedAt = time.Unix(resolved.Int64, 0).UTC()
			c.Resolved = true
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ResolveConflict marks a conflict decided and records how. The row is kept
// rather than deleted: the history of a lost race is worth seeing in status.
func (s *Store) ResolveConflict(id int64, resolution string) error {
	res, err := s.db.Exec(`
		UPDATE conflicts SET resolution = ?, resolved_at = ?
		WHERE id = ? AND resolved_at IS NULL`,
		resolution, time.Now().UTC().Unix(), id)
	if err != nil {
		return fmt.Errorf("resolve conflict %d: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("conflict %d: %w", id, ErrNotFound)
	}
	return nil
}

// ConflictByID returns one conflict.
func (s *Store) ConflictByID(id int64) (ConflictRow, error) {
	var c ConflictRow
	var detected int64
	var resolved sql.NullInt64
	err := s.db.QueryRow(`
		SELECT id, path, kind, base_version, local_version, remote_version,
		       local_hash, remote_hash, peer_id, kept_path, resolution,
		       detected_at, resolved_at
		FROM conflicts WHERE id = ?`, id).
		Scan(&c.ID, &c.Path, &c.Kind, &c.BaseVersion, &c.LocalVersion,
			&c.RemoteVersion, &c.LocalHash, &c.RemoteHash, &c.PeerID, &c.KeptPath,
			&c.Resolution, &detected, &resolved)
	if errors.Is(err, sql.ErrNoRows) {
		return c, fmt.Errorf("conflict %d: %w", id, ErrNotFound)
	}
	if err != nil {
		return c, err
	}
	c.DetectedAt = time.Unix(detected, 0).UTC()
	if resolved.Valid {
		c.ResolvedAt = time.Unix(resolved.Int64, 0).UTC()
		c.Resolved = true
	}
	return c, nil
}

// CountUnresolvedConflicts reports how many conflicts need a decision.
func (s *Store) CountUnresolvedConflicts() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM conflicts WHERE resolved_at IS NULL`).Scan(&n)
	return n, err
}
