package workspace

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"elia-go/internal/mesh/security"
)

// ConflictDirName holds preserved copies of versions this peer refused to apply.
//
// It sits inside the workspace so the copies are easy to find, but it is in the
// ignore list, so a conflict never syncs back to the peer that caused it. That
// asymmetry is deliberate: the two sides must not fight over a file neither of
// them accepted.
const ConflictDirName = ".workspace-conflicts"

// ConflictCopy describes where a refused version was preserved.
type ConflictCopy struct {
	// Path is workspace-relative, safe to pass to the filesystem helpers.
	Path string
	// Absolute is the same file on disk.
	Absolute string
	// Stamp distinguishes several conflicts on one path.
	Stamp string
}

// ConflictNameFor builds the workspace-relative path a refused version is
// preserved at, without writing anything.
//
// The name carries the peer, a timestamp and a hash of the original path, so
// repeated conflicts on one file are all kept and two files never collide.
func ConflictNameFor(rel, peerID string, at time.Time) string {
	stamp := fmt.Sprintf("%s-%s-%s", sanitizeStamp(peerID), at.UTC().Format("20060102T150405Z"), shortHash(rel))
	return path.Join(ConflictDirName, sanitizeName(path.Base(rel))+"."+stamp)
}

// PreserveConflict writes content to the conflict directory instead of over the
// live file, and returns where it landed.
//
// This is the mechanism behind "preserve conflicting data and notify the user".
// The live file is never touched; the incoming version is written beside it so
// the user can diff the two and decide, and so nothing the remote peer sent is
// thrown away.
func (w *Workspace) PreserveConflict(rel string, content []byte, peerID string, at time.Time) (ConflictCopy, error) {
	if err := security.ValidateRelPath(rel); err != nil {
		return ConflictCopy{}, err
	}
	// A flat name inside the conflict directory rather than a mirrored tree:
	// nested paths would need creating, and the user wants one directory to look
	// in, not a replica of their project.
	relOut := ConflictNameFor(rel, peerID, at)
	abs, err := security.SecureMkdirAll(w.Root, relOut)
	if err != nil {
		return ConflictCopy{}, err
	}
	if err := writeFileAtomic(abs, content); err != nil {
		return ConflictCopy{}, err
	}
	return ConflictCopy{Path: relOut, Absolute: abs}, nil
}

// HashAt hashes one workspace file, returning "" when it is absent or unreadable.
// A missing file is not an error here: callers use this to compare content, and
// "no file" is a legitimate answer to that question.
func HashAt(root, rel string, ignore *IgnoreSet) (string, error) {
	if err := security.ValidateRelPath(rel); err != nil {
		return "", err
	}
	abs, err := security.SecureJoin(root, rel)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil
	}
	return HashFile(abs)
}

// ListConflictCopies returns the preserved copies on disk, newest last.
func (w *Workspace) ListConflictCopies() ([]string, error) {
	dir := filepath.Join(w.Root, ConflictDirName)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if isNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			out = append(out, path.Join(ConflictDirName, e.Name()))
		}
	}
	return out, nil
}

func isNotExist(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

// sanitizeName keeps a base filename usable as part of a flat conflict name.
func sanitizeName(base string) string {
	var b strings.Builder
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '.' || r == '-' || r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	name := b.String()
	if len(name) > 60 {
		name = name[:60]
	}
	if name == "" {
		name = "file"
	}
	return name
}

// sanitizeStamp makes a peer id safe for a filename.
func sanitizeStamp(s string) string {
	if s == "" {
		return "peer"
	}
	if len(s) > 8 {
		s = s[:8]
	}
	return sanitizeName(s)
}

// shortHash gives each conflicting path its own suffix, so two conflicts in one
// second on different files do not collide.
func shortHash(s string) string {
	return HashBytes([]byte(s))[:8]
}

// WriteFileAtomic replaces a file's contents in one step: it writes a temporary
// file in the same directory and renames it over the target. A reader therefore
// never sees a half-written file, and an interrupted write cannot leave a
// truncated one behind.
func WriteFileAtomic(abs string, content []byte, perm os.FileMode) error {
	tmp := abs + ".tmp"
	if err := os.WriteFile(tmp, content, perm); err != nil {
		return err
	}
	if err := os.Rename(tmp, abs); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func writeFileAtomic(abs string, content []byte) error {
	return WriteFileAtomic(abs, content, 0o644)
}
