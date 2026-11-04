// Package security holds the controls that every other layer depends on: path
// validation, symlink rejection, size limits and join-code handling. Nothing
// in the sync path may touch the filesystem without going through here.
package security

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Size limits. Exceeding any of these is a protocol error, not a crash.
const (
	// MaxFileSize is the largest single file that may be synced.
	MaxFileSize int64 = 16 << 20 // 16 MiB
	// MaxWorkspaceSize caps the total tracked bytes in one workspace.
	MaxWorkspaceSize int64 = 512 << 20 // 512 MiB
	// MaxFrameSize is the largest single protocol frame.
	MaxFrameSize int64 = 8 << 20 // 8 MiB
	// MaxPathLen bounds a workspace-relative path. Deep trees are a sign of
	// something hostile, and no legitimate file needs this.
	MaxPathLen = 1024
	// MaxPathSegments bounds component count, independent of total length.
	MaxPathSegments = 64
)

// PathError describes why a path was rejected. Callers log this; it is never
// sent verbatim to the remote peer.
type PathError struct {
	Path   string
	Reason string
}

func (e *PathError) Error() string {
	return fmt.Sprintf("unsafe path %q: %s", e.Path, e.Reason)
}

func reject(path, reason string) error {
	return &PathError{Path: path, Reason: reason}
}

// ErrNotRegularFile means a path resolved to something other than a plain file.
var ErrNotRegularFile = errors.New("not a regular file")

// ErrTooLarge means a file or frame exceeded its cap.
var ErrTooLarge = errors.New("size limit exceeded")

// ErrWorkspaceFull means accepting more content would take the workspace past
// MaxWorkspaceSize. It is separate from ErrTooLarge because the remedy differs:
// a too-large file is a malformed request, while a full workspace is a
// legitimate but unacceptable amount of data.
var ErrWorkspaceFull = errors.New("workspace size limit exceeded")

// CheckWorkspaceGrowth verifies that adding incoming bytes to a workspace that
// currently holds current bytes stays inside MaxWorkspaceSize.
//
// This exists because the per-file and per-frame caps alone do not bound a
// workspace: a peer offering ten thousand legal 16 MiB files fills the disk
// while every individual frame passes validation. The receive path calls this
// before committing, so the cap is enforced rather than merely documented.
func CheckWorkspaceGrowth(current, incoming int64) error {
	if incoming < 0 {
		return reject("", "negative size")
	}
	if current < 0 {
		current = 0
	}
	if current+incoming > MaxWorkspaceSize {
		return fmt.Errorf("%w: %d + %d bytes would exceed %d",
			ErrWorkspaceFull, current, incoming, MaxWorkspaceSize)
	}
	return nil
}

// ValidateRelPath checks a workspace-relative path without touching the
// filesystem. It is the first gate: run it on any path that arrived over the
// wire, before doing anything else with the value.
//
// Rejects: absolute paths, drive letters, "." and ".." segments, empty
// segments, NUL bytes, non-UTF-8 bytes, and over-long paths.
func ValidateRelPath(p string) error {
	switch {
	case p == "":
		return reject(p, "empty path")
	case !utf8.ValidString(p):
		return reject(p, "path is not valid UTF-8")
	case strings.ContainsRune(p, 0):
		return reject(p, "path contains NUL byte")
	case strings.ContainsRune(p, '\\'):
		return reject(p, "path contains backslash")
	case len(p) > MaxPathLen:
		return reject(p, fmt.Sprintf("path longer than %d bytes", MaxPathLen))
	}

	// filepath.IsAbs catches "/x" and, on Windows, "C:\x". A leading slash is
	// also caught by the segment split below, but check explicitly for clarity.
	if filepath.IsAbs(p) || strings.HasPrefix(p, "/") {
		return reject(p, "absolute path")
	}
	if len(p) >= 2 && p[1] == ':' {
		return reject(p, "path contains a drive letter")
	}

	segs := strings.Split(p, "/")
	if len(segs) > MaxPathSegments {
		return reject(p, fmt.Sprintf("more than %d path segments", MaxPathSegments))
	}
	for _, seg := range segs {
		switch seg {
		case "":
			return reject(p, "empty path segment")
		case ".":
			return reject(p, "contains a \".\" segment")
		case "..":
			return reject(p, "contains a \"..\" segment")
		}
	}
	return nil
}

// SecureJoin validates rel and resolves it under root, refusing to traverse any
// symlink along the way.
//
// The per-component Lstat walk is what makes this safe. Cleaning the path and
// prefix-checking the result is not enough: if "link" is a symlink to "/etc",
// then root/link/passwd cleans to root/link/passwd, which still starts with
// root, yet the write lands in /etc. Each component is checked as it is
// descended, so a symlinked parent is caught before it is used.
func SecureJoin(root, rel string) (string, error) {
	if err := ValidateRelPath(rel); err != nil {
		return "", err
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve root: %w", err)
	}

	current := absRoot
	// Confirm the root itself is a real directory, not a symlink to somewhere
	// unexpected.
	rootInfo, err := os.Lstat(absRoot)
	if err != nil {
		return "", fmt.Errorf("stat workspace root: %w", err)
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", reject(root, "workspace root is a symlink")
	}
	if !rootInfo.IsDir() {
		return "", fmt.Errorf("workspace root %q is not a directory", root)
	}

	segs := strings.Split(rel, "/")
	for i, seg := range segs {
		current = filepath.Join(current, seg)
		isLeaf := i == len(segs)-1

		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			// The leaf may legitimately not exist yet (a create). Its parent
			// chain has already been verified, so this is safe. A missing
			// parent, however, means the tree is not what was claimed.
			if isLeaf {
				return current, nil
			}
			return "", fmt.Errorf("resolve %q: %w", rel, err)
		}
		if err != nil {
			return "", fmt.Errorf("resolve %q: %w", rel, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", reject(rel, fmt.Sprintf("component %q is a symlink", seg))
		}
		if !isLeaf && !info.IsDir() {
			return "", reject(rel, fmt.Sprintf("component %q is not a directory", seg))
		}
	}
	return current, nil
}

// SecureMkdirAll creates the parent directories for rel under root and returns
// the resolved absolute path of rel.
//
// It exists because SecureJoin deliberately refuses a missing intermediate
// directory, and a joiner receiving "src/app.py" into an empty workspace has no
// "src" to resolve. The two jobs need different rules: a read may only touch
// what the manifest described, while a receive has to build the tree first.
//
// Safety comes from the same per-component descent. Each segment is created
// only after its own parent has been confirmed to be a real directory, and any
// existing segment that is a symlink aborts the walk. A hostile peer therefore
// cannot steer a joiner out of its workspace by pre-planting a link at "src".
func SecureMkdirAll(root, rel string) (string, error) {
	if err := ValidateRelPath(rel); err != nil {
		return "", err
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve root: %w", err)
	}
	rootInfo, err := os.Lstat(absRoot)
	if err != nil {
		return "", fmt.Errorf("stat workspace root: %w", err)
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", reject(root, "workspace root is a symlink")
	}
	if !rootInfo.IsDir() {
		return "", fmt.Errorf("workspace root %q is not a directory", absRoot)
	}

	current := absRoot
	segs := strings.Split(rel, "/")
	for i, seg := range segs {
		current = filepath.Join(current, seg)
		isLeaf := i == len(segs)-1

		info, err := os.Lstat(current)
		switch {
		case errors.Is(err, os.ErrNotExist):
			if isLeaf {
				// The file itself is created later; only its parents belong here.
				return current, nil
			}
			if err := os.Mkdir(current, 0o755); err != nil {
				// Losing a race with another writer is fine; anything else is not.
				if !errors.Is(err, os.ErrExist) {
					return "", fmt.Errorf("create directory for %q: %w", rel, err)
				}
			}
			continue
		case err != nil:
			return "", fmt.Errorf("resolve %q: %w", rel, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", reject(rel, fmt.Sprintf("component %q is a symlink", seg))
		}
		if !isLeaf && !info.IsDir() {
			return "", reject(rel, fmt.Sprintf("component %q is not a directory", seg))
		}
	}
	return current, nil
}

// ValidateFileForSync performs every check that must pass before a remote file
// is written into the workspace: path safety, symlink safety, regular-file
// type and size. missingOK allows the leaf to be absent.
func ValidateFileForSync(root, rel string, size int64, missingOK bool) (string, error) {
	if size > MaxFileSize {
		return "", fmt.Errorf("file %q is %d bytes: %w (limit %d)", rel, size, ErrTooLarge, MaxFileSize)
	}
	if size < 0 {
		return "", reject(rel, "negative size")
	}

	abs, err := SecureJoin(root, rel)
	if err != nil {
		return "", err
	}

	info, err := os.Lstat(abs)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if !missingOK {
			return "", fmt.Errorf("stat %q: %w", rel, err)
		}
		return abs, nil
	case err != nil:
		return "", fmt.Errorf("stat %q: %w", rel, err)
	}

	if info.Mode()&os.ModeSymlink != 0 {
		return "", reject(rel, "target is a symlink")
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("file %q: %w", rel, ErrNotRegularFile)
	}
	if info.Size() != size {
		return "", fmt.Errorf("file %q: on-disk size %d does not match declared %d", rel, info.Size(), size)
	}
	return abs, nil
}

// ValidateWorkspaceID enforces the identifier format so a hostile peer cannot
// inject arbitrary strings into paths, logs or SQL.
func ValidateWorkspaceID(id string) error {
	const prefix = "ws_"
	const body = 6

	if len(id) != len(prefix)+body {
		return fmt.Errorf("invalid workspace id %q: want %d characters", id, len(prefix)+body)
	}
	if !strings.HasPrefix(id, prefix) {
		return fmt.Errorf("invalid workspace id %q: missing %q prefix", id, prefix)
	}
	for _, c := range id[len(prefix):] {
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !isHex {
			return fmt.Errorf("invalid workspace id %q: %q is not a hex character", id, c)
		}
	}
	return nil
}

// ValidatePeerID checks the peer identifier format.
func ValidatePeerID(id string) error {
	const body = 6
	if len(id) != body {
		return fmt.Errorf("invalid peer id %q: want %d characters", id, body)
	}
	for _, c := range id {
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !isHex {
			return fmt.Errorf("invalid peer id %q: %q is not a hex character", id, c)
		}
	}
	return nil
}
