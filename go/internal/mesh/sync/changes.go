package sync

import (
	"strings"
	"time"
)

// ChangeOp is what happened to a file locally.
type ChangeOp string

// The operations a live change can carry. Create, update and delete are distinct
// because the version arithmetic differs: a created file has no base to apply
// against, and a deleted one has nothing left to patch.
const (
	OpCreate ChangeOp = "create"
	OpUpdate ChangeOp = "update"
	OpDelete ChangeOp = "delete"
	// OpRename is reported as a delete plus a create rather than being sent
	// alone. A rename is not atomic across peers here, and pretending it is
	// would mean a half-applied move leaving a file missing on one side. The
	// trade is deliberate: the two steps are individually idempotent, a move is
	// not.
	OpRename ChangeOp = "rename"
)

// FileChange is one local edit on its way to a peer.
type FileChange struct {
	Op   ChangeOp `json:"op"`
	Path string   `json:"path"`
	// NewPath is set only for OpRename.
	NewPath string `json:"new_path,omitempty"`

	// BaseVersion is the version the change was made on top of, and Version is
	// what the file becomes. The receiver applies the change only when its own
	// version equals BaseVersion; otherwise both sides moved and the change is
	// a conflict. This single pair of numbers is what prevents one side's edit
	// from silently overwriting the other's.
	BaseVersion int64 `json:"base_version"`
	Version     int64 `json:"version"`

	OldHash string `json:"old_hash"`
	NewHash string `json:"new_hash"`
	Size    int64  `json:"size"`

	// Patch is a unified diff, base64-encoded by the JSON layer. It is used for
	// text files; an empty Patch with Full set means the content follows as
	// FILE_TRANSFER frames instead, which is how binary and oversized files
	// travel.
	Patch []byte `json:"patch,omitempty"`
	Full  bool   `json:"full,omitempty"`
}

// OriginLocal marks a change as originating on this machine rather than being
// received from a peer. OriginNode carries a peer ID instead for inbound
// changes. A consumer cannot tell the two apart from a peer ID alone, because a
// local machine also has one.
const OriginLocal = "local"

// ChangeEvent is one file change, described structurally rather than as prose.
//
// This is the machine-readable counterpart to the EventSink, and it exists
// because a consumer such as Elia needs to record what happened to a file
// without parsing a human sentence. The engine emits it at the points where a
// change is actually built, sent, applied or refused.
type ChangeEvent struct {
	// Path is workspace-relative, slash-separated.
	Path string   `json:"path"`
	Op   ChangeOp `json:"op"`
	// OriginNode is OriginLocal for a local edit, or the sending peer's ID.
	OriginNode string `json:"origin_node"`

	BaseVersion int64  `json:"base_version"`
	Version     int64  `json:"version"`
	OldHash     string `json:"old_hash,omitempty"`
	NewHash     string `json:"new_hash,omitempty"`
	Size        int64  `json:"size"`

	// Added and Removed count changed lines, and are reported only when the
	// change travelled as a patch. A whole-file transfer has no diff to count,
	// so the counts are omitted rather than guessed: a consumer that stores them
	// must be able to tell "no lines changed" from "not counted".
	Added   *int `json:"added,omitempty"`
	Removed *int `json:"removed,omitempty"`

	// Patch is the unified diff, present only for text changes that travelled as
	// a patch. A consumer may keep it in memory for display and must not persist
	// it: the body is ephemeral, and the hashes above are the durable record.
	Patch string `json:"patch,omitempty"`

	// Conflict is set when the change was refused or preserved as a divergence
	// rather than applied. KeptPath, when present, is where a preserved copy
	// landed inside this workspace.
	Conflict bool   `json:"conflict,omitempty"`
	KeptPath string `json:"kept_path,omitempty"`
	// Reason explains a conflict in words.
	Reason string `json:"reason,omitempty"`
}

// ChangeObserver receives a ChangeEvent for each file change. A nil observer
// discards them. It is called from the engine's goroutines, so an implementation
// must not block: the NDJSON writer used by `attach --stdio` serialises onto a
// channel and lets a dedicated goroutine do the writing.
type ChangeObserver func(ChangeEvent)

// Observe delivers a change event, discarding it if the observer is nil.
func (o ChangeObserver) Observe(ev ChangeEvent) {
	if o != nil {
		o(ev)
	}
}

// DiffCounts returns the added and removed line counts of a unified diff, and
// whether the diff actually looked like one. A caller that gets false must omit
// the counts rather than report zero.
//
// Counting starts at the first hunk header on purpose. The "--- a/path" and
// "+++ b/path" lines that precede a hunk begin with "-" and "+" as well, and
// counting them would report two spurious additions and two spurious removals
// for every single change.
func DiffCounts(patch string) (added, removed int, ok bool) {
	inHunk := false
	for _, line := range strings.Split(patch, "\n") {
		if strings.HasPrefix(line, "@@") {
			inHunk = true
			ok = true
			continue
		}
		if !inHunk {
			continue
		}
		switch {
		case strings.HasPrefix(line, "+"):
			added++
		case strings.HasPrefix(line, "-"):
			removed++
		}
	}
	return added, removed, ok
}

// Changes is a batch of local edits, sent as one frame so a burst of saves is
// one message rather than a storm.
type Changes struct {
	WorkspaceID string       `json:"workspace_id"`
	PeerID      string       `json:"peer_id"`
	Changes     []FileChange `json:"changes"`
}

// SyncDone closes a batch. Without it a receiver cannot tell "that was
// everything" from "more is coming", and would report progress while idle.
type SyncDone struct {
	// Files is how many changes were sent.
	Files int `json:"files"`
	// Divergent is how many were refused as conflicts.
	Divergent int `json:"divergent"`
}

// ConflictReport tells a peer that a change it sent was not applied, and why.
//
// Sending this matters for more than tidiness: without it the sender would
// record its version as agreed and never learn that its work is sitting in a
// conflict directory, so the next resync would show nothing and the user would
// believe everything was fine.
type ConflictReport struct {
	Path          string `json:"path"`
	Kind          string `json:"kind"`
	BaseVersion   int64  `json:"base_version"`
	LocalVersion  int64  `json:"local_version"`
	RemoteVersion int64  `json:"remote_version"`
	LocalHash     string `json:"local_hash"`
	RemoteHash    string `json:"remote_hash"`
	// KeptPath is workspace-relative on the receiver, where the incoming
	// version was preserved.
	KeptPath string `json:"kept_path,omitempty"`
	// ResendFull asks the sender to send the whole file rather than a patch.
	//
	// This is the reply to a patch that would not apply, which is a different
	// problem from a version conflict. A patch fails when the content moved in a
	// way the version numbers do not show: a hand-edited file, or a line-ending
	// difference. Asking for the whole file lets the change land when the two
	// sides do in fact agree, and produces a preserved copy when they do not, so
	// the same reply is the right move in both cases.
	ResendFull bool `json:"resend_full,omitempty"`
	// Reason explains the refusal in words, for the event log.
	Reason string `json:"reason,omitempty"`
}

// Ping is a liveness probe.
type Ping struct {
	// ID correlates the reply. Echoing it is what proves the peer is the one
	// that answered rather than something merely in the path.
	ID   string    `json:"id"`
	Sent time.Time `json:"sent"`
}

// Pong answers a Ping.
type Pong struct {
	ID   string    `json:"id"`
	Sent time.Time `json:"sent"`
}

// Leave is a clean goodbye, so the peer can report a disconnect rather than a
// dropped connection.
type Leave struct {
	PeerID string `json:"peer_id"`
	Reason string `json:"reason,omitempty"`
}
