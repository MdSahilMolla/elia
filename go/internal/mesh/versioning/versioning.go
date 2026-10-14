// Package versioning decides whether an incoming change can be applied or has
// to become a conflict.
//
// The whole model is two numbers per file. Each peer keeps a version, and a
// change announces the version it was made on top of alongside the version it
// produces. A change applies only when the receiver's own version is exactly
// the one the change was built on. Anything else means both sides moved, and
// the change is preserved instead.
//
// That is deliberately the conservative rule. It reports a conflict for two edits
// to the same file that touched different lines and could have been merged, which
// a merge-capable system would resolve silently. The plan asks for a prototype
// that preserves and notifies rather than merges, and a rule that guesses
// "probably fine" is how a file gets lost.
package versioning

import (
	"errors"
	"time"

	"elia-go/internal/mesh/store"
	"elia-go/internal/mesh/workspace"
)

// ErrNotImplemented is retained for callers that checked for the phase-6 stub.
// The version checks it guarded are now enforced on every change.
var ErrNotImplemented = errors.New("versioning: phase 6 is not implemented")

// Conflict kinds, matching the store's vocabulary.
const (
	// ConflictBothEdited means both peers changed a file from the same base.
	ConflictBothEdited = store.ConflictBothEdited
	// ConflictDeleteEdit means one peer deleted what the other edited.
	ConflictDeleteEdit = store.ConflictDeleteEdit
	// ConflictRemoteNewer means the remote change did not apply to the base it
	// expected and the local file is untouched since the last agreement.
	ConflictRemoteNewer = store.ConflictRemoteNewer
)

// Conflict describes a change that could not be applied.
type Conflict struct {
	Path          string
	Kind          string
	BaseVersion   int64
	LocalVersion  int64
	RemoteVersion int64
	LocalHash     string
	RemoteHash    string
	// Kept is where the incoming version was preserved, if it was.
	Kept string
	// Resolution is the user's eventual choice. Empty until they pick one.
	Resolution string
}

// Decision is the outcome of checking one incoming change.
type Decision struct {
	// Apply is true when the change may be written to disk.
	Apply bool
	// Conflict is set when it may not.
	Conflict *Conflict
	// Reason explains the decision, for the event log.
	Reason string
}

// Tracker checks changes against local state and records the outcomes.
type Tracker struct {
	ws *workspace.Workspace
}

// NewTracker returns a tracker backed by the workspace's store.
func NewTracker(ws *workspace.Workspace) *Tracker { return &Tracker{ws: ws} }

// Base returns the version this peer last agreed on for a path, and the content
// hash at that agreement. A path with no record returns version 0, which is
// what makes a genuinely new file apply cleanly while an unknown edit does not.
func (t *Tracker) Base(path string) (version int64, hash string, err error) {
	row, err := t.ws.Store.GetFile(path)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return 0, "", nil
		}
		return 0, "", err
	}
	return row.Version, row.SHA256, nil
}

// Local describes what is actually on disk for a path, which is what makes a
// conflict two-sided: the store says what was agreed, the disk says what the
// user has now.
func (t *Tracker) Local(path string) (version int64, hash string, exists bool, err error) {
	version, hash, err = t.Base(path)
	if err != nil {
		return 0, "", false, err
	}
	exists, onDisk, err := t.ws.LocalExists(path)
	if err != nil {
		return 0, "", false, err
	}
	return version, onDisk, exists, nil
}

// Check decides whether an incoming change may be applied.
//
// The three cases, in order:
//
//   - A change to a file this peer has never seen applies. There is no local
//     work to lose.
//   - A change whose base equals the local version applies, provided the local
//     file still matches the agreed content. If the local file has moved on
//     since, the peer did not see the sender's change and both sides edited.
//   - Anything else is a conflict.
func (t *Tracker) Check(change Change) (Decision, error) {
	localVersion, agreedHash, err := t.Base(change.Path)
	if err != nil {
		return Decision{}, err
	}
	exists, onDisk, err := t.ws.LocalExists(change.Path)
	if err != nil {
		return Decision{}, err
	}

	// Deletion: a delete applies when the local side has not moved on, and
	// conflicts when the local file was edited rather than deleted, because
	// deleting it would destroy the edit.
	if change.Op == OpDelete {
		if !exists && localVersion == 0 {
			return Decision{Apply: true, Reason: "already absent"}, nil
		}
		if exists && onDisk == agreedHash && localVersion == change.BaseVersion {
			return Decision{Apply: true, Reason: "delete applies"}, nil
		}
		if !exists {
			return Decision{Apply: true, Reason: "already deleted locally"}, nil
		}
		return Decision{Conflict: &Conflict{
			Path:          change.Path,
			Kind:          ConflictDeleteEdit,
			BaseVersion:   change.BaseVersion,
			LocalVersion:  localVersion,
			RemoteVersion: change.Version,
			LocalHash:     onDisk,
			RemoteHash:    "",
		}}, nil
	}

	if !exists {
		// A file this peer has never had. The only way that happens alongside a
		// non-zero base version is if the file was deleted locally after the
		// agreement, which is a delete-edit conflict rather than a create.
		if localVersion == 0 {
			return Decision{Apply: true, Reason: "new file"}, nil
		}
		return Decision{Conflict: &Conflict{
			Path:          change.Path,
			Kind:          ConflictDeleteEdit,
			BaseVersion:   change.BaseVersion,
			LocalVersion:  localVersion,
			RemoteVersion: change.Version,
			LocalHash:     "",
			RemoteHash:    change.NewHash,
		}}, nil
	}

	// A local edit that no peer has accepted is not a base anything can be
	// applied to. The version numbers can coincide by accident, and applying on a
	// version match alone would overwrite work that exists nowhere else.
	pending, err := t.ws.PendingLocal(change.Path)
	if err != nil {
		return Decision{}, err
	}
	if pending {
		return Decision{Conflict: &Conflict{
			Path:          change.Path,
			Kind:          ConflictBothEdited,
			BaseVersion:   change.BaseVersion,
			LocalVersion:  localVersion,
			RemoteVersion: change.Version,
			LocalHash:     onDisk,
			RemoteHash:    change.NewHash,
		}}, nil
	}

	if localVersion != change.BaseVersion {
		return Decision{Conflict: &Conflict{
			Path:          change.Path,
			Kind:          ConflictBothEdited,
			BaseVersion:   change.BaseVersion,
			LocalVersion:  localVersion,
			RemoteVersion: change.Version,
			LocalHash:     onDisk,
			RemoteHash:    change.NewHash,
		}}, nil
	}

	// The versions agree, but the content may still have moved: an edit made
	// while offline bumps the local version, and a hand-edited file may not.
	if onDisk != agreedHash && change.NewHash != onDisk {
		return Decision{Conflict: &Conflict{
			Path:          change.Path,
			Kind:          ConflictBothEdited,
			BaseVersion:   change.BaseVersion,
			LocalVersion:  localVersion,
			RemoteVersion: change.Version,
			LocalHash:     onDisk,
			RemoteHash:    change.NewHash,
		}}, nil
	}

	// The change is already here: the same content arrived twice, which happens
	// when a resync and a live patch race. Applying it again is harmless but
	// pointless, and skipping it avoids a pointless write and a watcher event.
	if change.NewHash == onDisk {
		return Decision{Apply: true, Reason: "already current"}, nil
	}

	return Decision{Apply: true, Reason: "applies"}, nil
}

// Op mirrors the sync operation names so this package does not depend on the
// transport layer.
type Op = string

// The operations, restated here so the tracker can be used without importing
// sync.
const (
	OpCreate Op = "create"
	OpUpdate Op = "update"
	OpDelete Op = "delete"
	OpRename Op = "rename"
)

// Change is the minimum an incoming change has to say for a decision.
type Change struct {
	Op          Op
	Path        string
	BaseVersion int64
	Version     int64
	NewHash     string
	OldHash     string
	Size        int64
}

// CheckResync decides whether a change from a catch-up pass may be applied.
//
// A resync is not the same question as a live change, and using Check here would
// produce a flood of false conflicts. A live change has to apply to the exact
// version it names, because the two sides were editing at the same moment and one
// order of events is the only safe answer. A resync happens after a disconnect,
// when the remote is simply behind and is reporting what it missed. Refusing
// those changes would make a peer that was offline for an hour come back with
// every file it had touched marked as a conflict.
//
// The extra input is OldHash: the content hash the remote believes the two sides
// last agreed on. That is what distinguishes the two cases. If the local file
// still holds that hash, the remote's change was built on exactly what is here
// and it applies, even though the local version has moved further ahead in the
// meantime. If it does not, both sides genuinely changed the same file, and the
// answer is a conflict.
//
// The remaining case, where neither the base version nor the agreed hash matches,
// is reported as a conflict. It is not safe to fast-forward: local content that
// matches neither the remote's base nor its new version cannot be shown to be an
// ancestor of the remote's edit, and applying it anyway would overwrite work.
func (t *Tracker) CheckResync(change Change) (Decision, error) {
	localVersion, agreedHash, err := t.Base(change.Path)
	if err != nil {
		return Decision{}, err
	}
	exists, onDisk, err := t.ws.LocalExists(change.Path)
	if err != nil {
		return Decision{}, err
	}

	if change.Op == OpDelete {
		if !exists {
			return Decision{Apply: true, Reason: "already absent"}, nil
		}
		if onDisk == change.OldHash {
			return Decision{Apply: true, Reason: "delete applies to the agreed content"}, nil
		}
		return Decision{Conflict: &Conflict{
			Path:          change.Path,
			Kind:          ConflictDeleteEdit,
			BaseVersion:   change.BaseVersion,
			LocalVersion:  localVersion,
			RemoteVersion: change.Version,
			LocalHash:     onDisk,
		}}, nil
	}

	if !exists {
		if localVersion == 0 {
			return Decision{Apply: true, Reason: "new file"}, nil
		}
		return Decision{Conflict: &Conflict{
			Path:          change.Path,
			Kind:          ConflictDeleteEdit,
			BaseVersion:   change.BaseVersion,
			LocalVersion:  localVersion,
			RemoteVersion: change.Version,
			RemoteHash:    change.NewHash,
		}}, nil
	}

	if change.NewHash == onDisk {
		return Decision{Apply: true, Reason: "already current"}, nil
	}
	// A local edit that no peer has accepted blocks a resync too. A peer catching
	// up is not entitled to overwrite work the local side has not had agreed.
	if pending, err := t.ws.PendingLocal(change.Path); err != nil {
		return Decision{}, err
	} else if pending {
		return Decision{Conflict: &Conflict{
			Path:          change.Path,
			Kind:          ConflictBothEdited,
			BaseVersion:   change.BaseVersion,
			LocalVersion:  localVersion,
			RemoteVersion: change.Version,
			LocalHash:     onDisk,
			RemoteHash:    change.NewHash,
		}}, nil
	}
	// The local file is still what the remote thinks both peers agreed on, so the
	// remote's change sits directly on top of it.
	if change.OldHash != "" && onDisk == change.OldHash {
		return Decision{Apply: true, Reason: "fast-forwarding to the remote's version"}, nil
	}
	if agreedHash != "" && onDisk == agreedHash && localVersion == change.BaseVersion {
		return Decision{Apply: true, Reason: "applies"}, nil
	}

	kind := ConflictBothEdited
	if localVersion == change.BaseVersion {
		// The versions line up, so both sides edited the same base. That is the
		// textbook both-edited case and worth distinguishing from a version gap.
		kind = ConflictBothEdited
	} else {
		kind = ConflictRemoteNewer
	}
	return Decision{Conflict: &Conflict{
		Path:          change.Path,
		Kind:          kind,
		BaseVersion:   change.BaseVersion,
		LocalVersion:  localVersion,
		RemoteVersion: change.Version,
		LocalHash:     onDisk,
		RemoteHash:    change.NewHash,
	}}, nil
}

// Advance records that a path has reached an agreed version.
func (t *Tracker) Advance(path string, size int64, hash string, version int64, writer string) error {
	return t.ws.RecordFile(path, size, hash, version, writer)
}

// Record stores a conflict so it can be listed and resolved later.
func (t *Tracker) Record(c Conflict, peerID string) (int64, error) {
	return t.ws.Store.RecordConflict(store.ConflictRow{
		Path:          c.Path,
		Kind:          c.Kind,
		BaseVersion:   c.BaseVersion,
		LocalVersion:  c.LocalVersion,
		RemoteVersion: c.RemoteVersion,
		LocalHash:     c.LocalHash,
		RemoteHash:    c.RemoteHash,
		PeerID:        peerID,
		KeptPath:      c.Kept,
		DetectedAt:    time.Now().UTC(),
	})
}

// Forget drops a path from the agreed state after a delete.
func (t *Tracker) Forget(path string) error {
	return t.ws.ForgetFile(path)
}
