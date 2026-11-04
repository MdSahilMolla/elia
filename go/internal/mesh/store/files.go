package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// FileRow is one tracked file in the workspace.
type FileRow struct {
	Path       string
	Size       int64
	SHA256     string
	Version    int64
	LastWriter string
	MTimeNS    int64
}

// PutFile inserts or replaces a tracked file.
func (s *Store) PutFile(f FileRow) error {
	_, err := s.db.Exec(`
		INSERT INTO files (path, size, sha256, version, last_writer, mtime_ns)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			size        = excluded.size,
			sha256      = excluded.sha256,
			version     = excluded.version,
			last_writer = excluded.last_writer,
			mtime_ns    = excluded.mtime_ns`,
		f.Path, f.Size, f.SHA256, f.Version, f.LastWriter, f.MTimeNS)
	return err
}

// AdvanceFile records a local change, but only if it moves the version forward.
//
// The condition is the point. A local edit is recorded after the change has been
// sent, while the peer's acknowledgement of that same change may arrive in
// between. Without the guard the later write wins and downgrades an acknowledged
// file back to "local, unconfirmed", which then blocks every subsequent change to
// that file with a conflict it should not have.
func (s *Store) AdvanceFile(f FileRow) (bool, error) {
	res, err := s.db.Exec(`
		INSERT INTO files (path, size, sha256, version, last_writer, mtime_ns)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			size        = excluded.size,
			sha256      = excluded.sha256,
			version     = excluded.version,
			last_writer = excluded.last_writer,
			mtime_ns    = excluded.mtime_ns
		WHERE files.version < excluded.version`,
		f.Path, f.Size, f.SHA256, f.Version, f.LastWriter, f.MTimeNS)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// ConfirmFile marks a change as agreed because a peer accepted it, allowing the
// same version to be rewritten so the writer can be upgraded from "local" to the
// peer's identity.
//
// Unlike AdvanceFile this accepts an equal version, because upgrading a pending
// local change to agreed is exactly a same-version rewrite.
func (s *Store) ConfirmFile(f FileRow) (bool, error) {
	res, err := s.db.Exec(`
		INSERT INTO files (path, size, sha256, version, last_writer, mtime_ns)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			size        = excluded.size,
			sha256      = excluded.sha256,
			version     = excluded.version,
			last_writer = excluded.last_writer,
			mtime_ns    = excluded.mtime_ns
		WHERE files.version <= excluded.version`,
		f.Path, f.Size, f.SHA256, f.Version, f.LastWriter, f.MTimeNS)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// UpsertFiles writes many rows in a single transaction.
func (s *Store) UpsertFiles(rows []FileRow) error {
	if len(rows) == 0 {
		return nil
	}
	return s.inTx(func(tx *sql.Tx) error {
		stmt, err := tx.Prepare(`
			INSERT INTO files (path, size, sha256, version, last_writer, mtime_ns)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET
				size        = excluded.size,
				sha256      = excluded.sha256,
				version     = excluded.version,
				last_writer = excluded.last_writer,
				mtime_ns    = excluded.mtime_ns`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for _, r := range rows {
			if _, err := stmt.Exec(r.Path, r.Size, r.SHA256, r.Version, r.LastWriter, r.MTimeNS); err != nil {
				return fmt.Errorf("upsert %s: %w", r.Path, err)
			}
		}
		return nil
	})
}

// GetFile returns one tracked file, or ErrNotFound.
func (s *Store) GetFile(path string) (FileRow, error) {
	var f FileRow
	err := s.db.QueryRow(`
		SELECT path, size, sha256, version, COALESCE(last_writer, ''), mtime_ns
		FROM files WHERE path = ?`, path).
		Scan(&f.Path, &f.Size, &f.SHA256, &f.Version, &f.LastWriter, &f.MTimeNS)
	if errors.Is(err, sql.ErrNoRows) {
		return f, fmt.Errorf("file %q: %w", path, ErrNotFound)
	}
	return f, err
}

// AllFiles returns every tracked file, ordered by path.
func (s *Store) AllFiles() ([]FileRow, error) {
	rows, err := s.db.Query(`
		SELECT path, size, sha256, version, COALESCE(last_writer, ''), mtime_ns
		FROM files ORDER BY path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []FileRow
	for rows.Next() {
		var f FileRow
		if err := rows.Scan(&f.Path, &f.Size, &f.SHA256, &f.Version, &f.LastWriter, &f.MTimeNS); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// DeleteFile drops a tracked file.
func (s *Store) DeleteFile(path string) error {
	_, err := s.db.Exec(`DELETE FROM files WHERE path = ?`, path)
	return err
}

// CountFiles returns the number of tracked files.
func (s *Store) CountFiles() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM files`).Scan(&n)
	return n, err
}

func (s *Store) inTx(fn func(*sql.Tx) error) error {
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// PeerRow is a known workspace member.
type PeerRow struct {
	PeerID      string
	Role        string
	CertSHA256  string
	DisplayName string
	JoinedAt    time.Time
	LastSeen    time.Time
}

// Roles a peer can hold.
const (
	RoleHost   = "host"
	RoleMember = "member"
)

// AddPeer records a member, ignoring an existing row for the same peer.
func (s *Store) AddPeer(p PeerRow) error {
	_, err := s.db.Exec(`
		INSERT INTO peers (peer_id, role, cert_sha256, display_name, joined_at, last_seen)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(peer_id) DO UPDATE SET
			cert_sha256  = excluded.cert_sha256,
			display_name = excluded.display_name,
			last_seen    = excluded.last_seen`,
		p.PeerID, p.Role, p.CertSHA256, p.DisplayName,
		p.JoinedAt.UTC().Unix(), p.LastSeen.UTC().Unix())
	return err
}

// PeerByCert looks a member up by pinned certificate fingerprint. This is the
// credential used on reconnect: no join code is required again.
func (s *Store) PeerByCert(certSHA256 string) (PeerRow, error) {
	var p PeerRow
	var joined, seen int64
	err := s.db.QueryRow(`
		SELECT peer_id, role, cert_sha256, COALESCE(display_name, ''), joined_at, last_seen
		FROM peers WHERE cert_sha256 = ?`, certSHA256).
		Scan(&p.PeerID, &p.Role, &p.CertSHA256, &p.DisplayName, &joined, &seen)
	if errors.Is(err, sql.ErrNoRows) {
		return p, fmt.Errorf("peer cert: %w", ErrNotFound)
	}
	if err != nil {
		return p, err
	}
	p.JoinedAt = time.Unix(joined, 0).UTC()
	p.LastSeen = time.Unix(seen, 0).UTC()
	return p, nil
}

// TouchPeer records that a peer was seen just now, used to distinguish a live
// member from a stale one in status output.
func (s *Store) TouchPeer(peerID string) error {
	_, err := s.db.Exec(`UPDATE peers SET last_seen = ? WHERE peer_id = ?`,
		time.Now().UTC().Unix(), peerID)
	return err
}

// Peers lists all known peers.
func (s *Store) Peers() ([]PeerRow, error) {
	rows, err := s.db.Query(`
		SELECT peer_id, role, cert_sha256, COALESCE(display_name, ''), joined_at, last_seen
		FROM peers ORDER BY joined_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PeerRow
	for rows.Next() {
		var p PeerRow
		var joined, seen int64
		if err := rows.Scan(&p.PeerID, &p.Role, &p.CertSHA256, &p.DisplayName, &joined, &seen); err != nil {
			return nil, err
		}
		p.JoinedAt = time.Unix(joined, 0).UTC()
		p.LastSeen = time.Unix(seen, 0).UTC()
		out = append(out, p)
	}
	return out, rows.Err()
}
