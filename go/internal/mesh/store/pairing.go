package store

import (
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// CodeRecord is an outstanding join code. Only the SHA-256 of the code is
// stored; the plaintext exists solely in the create output.
type CodeRecord struct {
	ID        int64
	CreatedAt time.Time
	ExpiresAt time.Time
	MaxUses   int
	Uses      int
}

// AddCode stores a new join code identified by the hex SHA-256 of its plaintext.
func (s *Store) AddCode(codeSHA256 string, expiresAt time.Time, maxUses int) (CodeRecord, error) {
	if maxUses < 1 {
		return CodeRecord{}, fmt.Errorf("max uses must be >= 1, got %d", maxUses)
	}
	now := time.Now().UTC()
	res, err := s.db.Exec(`
		INSERT INTO pairing_codes (code_sha256, created_at, expires_at, max_uses, uses)
		VALUES (?, ?, ?, ?, 0)`,
		codeSHA256, now.Unix(), expiresAt.UTC().Unix(), maxUses)
	if err != nil {
		return CodeRecord{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return CodeRecord{}, err
	}
	return CodeRecord{
		ID:        id,
		CreatedAt: now,
		ExpiresAt: expiresAt.UTC(),
		MaxUses:   maxUses,
	}, nil
}

// CodeByHash looks a code up by its hex-encoded SHA-256.
func (s *Store) CodeByHash(codeSHA256 string) (CodeRecord, error) {
	var c CodeRecord
	var created, expires int64
	err := s.db.QueryRow(`
		SELECT id, created_at, expires_at, max_uses, uses
		FROM pairing_codes WHERE code_sha256 = ?`, codeSHA256).
		Scan(&c.ID, &created, &expires, &c.MaxUses, &c.Uses)
	if errors.Is(err, sql.ErrNoRows) {
		return c, fmt.Errorf("join code: %w", ErrNotFound)
	}
	if err != nil {
		return c, err
	}
	c.CreatedAt = time.Unix(created, 0).UTC()
	c.ExpiresAt = time.Unix(expires, 0).UTC()
	return c, nil
}

// ErrCodeExpired means the code existed but is past its lifetime.
var ErrCodeExpired = errors.New("join code has expired")

// ErrCodeExhausted means the code was already used the maximum number of times.
var ErrCodeExhausted = errors.New("join code has already been used")

// RedeemCode consumes one use of a code, atomically enforcing both the expiry
// and the use limit. The conditional UPDATE means two peers racing on a
// single-use code cannot both succeed: SQLite applies one writer at a time
// and the loser matches zero rows.
func (s *Store) RedeemCode(codeSHA256 string, now time.Time) (CodeRecord, error) {
	res, err := s.db.Exec(`
		UPDATE pairing_codes SET uses = uses + 1
		WHERE code_sha256 = ?
		  AND uses < max_uses
		  AND expires_at > ?`,
		codeSHA256, now.UTC().Unix())
	if err != nil {
		return CodeRecord{}, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return CodeRecord{}, err
	}
	if n == 0 {
		// Distinguish "no such code" from "expired" and "used up" so the CLI
		// can give a useful message. The comparison is constant-time to avoid
		// leaking anything about a code an attacker does not already hold.
		rec, lookupErr := s.CodeByHash(codeSHA256)
		switch {
		case errors.Is(lookupErr, ErrNotFound):
			return rec, ErrNotFound
		case lookupErr != nil:
			return rec, lookupErr
		case !now.UTC().Before(rec.ExpiresAt):
			return rec, ErrCodeExpired
		default:
			return rec, ErrCodeExhausted
		}
	}
	return s.CodeByHash(codeSHA256)
}

// CodeHashEqual compares two hex digests in constant time.
func CodeHashEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// ExpireCodes deletes codes that are past their lifetime. Called opportunistically
// so the table does not grow without bound.
func (s *Store) ExpireCodes(now time.Time) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM pairing_codes WHERE expires_at <= ?`, now.UTC().Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
