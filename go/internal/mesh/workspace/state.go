package workspace

import (
	"errors"
	"fmt"
	"io/fs"
	"os"

	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/store"
)

// TrackedEntries returns the last state this peer agreed on with its peers, read
// from the store rather than from disk.
//
// This is the "base" side of the three-way comparison in Diff. It is
// deliberately the database rather than a second hash of the disk: the point is
// to remember what both sides last agreed on, and only the store knows that.
func (w *Workspace) TrackedEntries() (map[string]FileEntry, error) {
	rows, err := w.Store.AllFiles()
	if err != nil {
		return nil, fmt.Errorf("read tracked files: %w", err)
	}
	out := make(map[string]FileEntry, len(rows))
	for _, r := range rows {
		out[r.Path] = FileEntry{
			Path:    r.Path,
			Size:    r.Size,
			Hash:    r.SHA256,
			Version: r.Version,
		}
	}
	return out, nil
}

// TrackedBytes returns the total size of the last agreed state.
func (w *Workspace) TrackedBytes() (int64, error) {
	return w.TotalTrackedBytes()
}

// LocalBytes returns the total size of what is actually on disk, which is what
// the workspace size cap is checked against. The store only knows about agreed
// state, so it would under-report a member that has accepted new files.
func (w *Workspace) LocalBytes() (int64, error) {
	entries, err := LocalEntries(w.Root, w.Ignore)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, e := range entries {
		total += e.Size
	}
	return total, nil
}

// LocalExists reports whether a workspace-relative path is present on disk right
// now, and what its content hash is.
//
// A conflict check needs both the store's view of what was agreed and the disk's
// view of what the user has done since, because either alone is misleading: the
// store alone cannot see a hand-edited file, and the disk alone cannot tell an
// edit from the same content arriving twice.
func (w *Workspace) LocalExists(rel string) (exists bool, hash string, err error) {
	abs, err := security.SecureJoin(w.Root, rel)
	if err != nil {
		// SecureJoin checks every path component, so a file inside a directory
		// that has not been created yet comes back as an error. For an existence
		// question the honest answer is "no", not a failure: a peer is about to
		// create exactly that directory.
		if errors.Is(err, fs.ErrNotExist) {
			return false, "", nil
		}
		return false, "", err
	}
	if _, err := os.Lstat(abs); err != nil {
		if os.IsNotExist(err) {
			return false, "", nil
		}
		return false, "", err
	}
	hash, err = HashAt(w.Root, rel, w.Ignore)
	if err != nil {
		return false, "", err
	}
	return true, hash, nil
}

// WriterLocal marks a tracked file whose newest version came from a local edit
// that no peer has confirmed yet.
//
// This is load-bearing rather than bookkeeping. A version counter alone cannot
// tell a peer's version 1 from a local version 1: a member that creates a file
// locally at version 1 and a host that edited an agreed file to version 1 are
// different worlds that look identical to a version comparison. Without this
// marker the member would see the host's change as "based on the version I am
// at", apply it, and silently overwrite its own unsent edit. A change that is
// still local is therefore not a base anything else can be applied to.
const WriterLocal = "local"

// PendingLocal reports whether a path's current version is a local edit that no
// peer has accepted yet.
func (w *Workspace) PendingLocal(rel string) (bool, error) {
	row, err := w.Store.GetFile(rel)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	return row.LastWriter == WriterLocal, nil
}

// CheckGrowth verifies that accepting incoming bytes stays inside the workspace
// size cap, measured against what is on disk right now. A file that is being
// replaced does not count twice: the caller passes the replacement's own size,
// because the old copy is about to be overwritten.
func (w *Workspace) CheckGrowth(incoming int64) error {
	current, err := w.LocalBytes()
	if err != nil {
		return fmt.Errorf("measure workspace: %w", err)
	}
	return security.CheckWorkspaceGrowth(current, incoming)
}

// CheckReplace verifies the size cap for replacing absPath with newSize bytes.
//
// The subtlety is that replacing a file is not purely additive: whatever the old
// copy weighs is about to disappear. Counting it as still present would reject
// large-but-legal replacements on a workspace that is already near the cap, and
// ignoring the new bytes entirely would accept a disk fill. So the old size is
// measured and netted off, with an ignored file counting as zero because it is
// not part of the tracked total.
func (w *Workspace) CheckReplace(absPath string, newSize int64) error {
	current, err := w.LocalBytes()
	if err != nil {
		return fmt.Errorf("measure workspace: %w", err)
	}
	var oldSize int64
	if info, err := os.Stat(absPath); err == nil && info.Mode().IsRegular() {
		oldSize = info.Size()
	}
	projected := current - oldSize + newSize
	if projected < 0 {
		projected = newSize
	}
	return security.CheckWorkspaceGrowth(0, projected)
}

// RecordFile notes the agreed state of a file so a later diff can tell an
// ordinary remote update from a real divergence.
func (w *Workspace) RecordFile(path string, size int64, hash string, version int64, writer string) error {
	return w.Store.PutFile(store.FileRow{
		Path:       path,
		Size:       size,
		SHA256:     hash,
		Version:    version,
		LastWriter: writer,
	})
}

// AdvanceFile records a local change, without demoting a change a peer has already
// acknowledged. It reports whether the row moved forward.
func (w *Workspace) AdvanceFile(path string, size int64, hash string, version int64) (bool, error) {
	return w.Store.AdvanceFile(store.FileRow{
		Path:       path,
		Size:       size,
		SHA256:     hash,
		Version:    version,
		LastWriter: WriterLocal,
	})
}

// ConfirmFile marks a path as agreed because a peer accepted the change.
//
// The same version may be rewritten here, unlike AdvanceFile, because upgrading a
// pending local change to agreed is precisely a same-version rewrite.
func (w *Workspace) ConfirmFile(path string, size int64, hash string, version int64, peerID string) (bool, error) {
	return w.Store.ConfirmFile(store.FileRow{
		Path:       path,
		Size:       size,
		SHA256:     hash,
		Version:    version,
		LastWriter: peerID,
	})
}

// ForgetFile drops a file from the agreed state, used when a delete is applied.
func (w *Workspace) ForgetFile(path string) error {
	return w.Store.DeleteFile(path)
}
