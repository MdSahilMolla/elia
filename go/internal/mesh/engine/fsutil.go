package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/workspace"
)

// readFile reads a workspace file in full.
//
// The engine works with whole files in memory throughout. That is a deliberate
// limit rather than an oversight: the protocol caps files at 16 MiB and the
// workspace at 512 MiB, so the worst case per operation is bounded, and holding
// the bytes makes the atomicity guarantees much easier to get right than a
// streaming path would. A file being synced also has to be hashed and compared
// before it is trusted, which wants the whole content anyway.
func readFile(abs string) ([]byte, error) {
	return os.ReadFile(abs)
}

// hashBytes is the one hashing function in the engine, so the digest format
// cannot drift between the value announced and the value computed.
func hashBytes(content []byte) (string, error) {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:]), nil
}

// fileSize returns a workspace file's size, or zero when it is gone.
func fileSize(ws *workspace.Workspace, rel string) (int64, error) {
	abs, err := security.SecureJoin(ws.Root, rel)
	if err != nil {
		return 0, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// removeIfPresent deletes a path and treats a missing file as success, which is
// what makes a delete idempotent.
func removeIfPresent(abs string) error {
	if err := os.Remove(abs); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	return nil
}

func osMkdirAll(abs string) error {
	return os.MkdirAll(filepath.Dir(abs), 0o755)
}

// atomicWrite replaces a file's contents in one step, so a reader never sees a
// half-written file and a crash cannot leave a truncated one.
//
// The temporary file is created in the destination directory rather than the
// system temporary one, because a rename across filesystems is not atomic and
// would reintroduce exactly the problem this avoids.
func atomicWrite(abs string, content []byte) error {
	dir := filepath.Dir(abs)
	tmp, err := os.CreateTemp(dir, ".ws-sync-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		// Best effort: if the rename succeeded there is nothing left to remove,
		// and if it failed the file is removed so no debris is left behind.
		_ = os.Remove(tmpName)
	}()

	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// The editor's mode is not preserved: a synced file is written with the
	// default for a new file, and a later local edit will not change that.
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpName, abs)
}
