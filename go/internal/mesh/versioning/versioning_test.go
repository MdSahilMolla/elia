package versioning

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/store"
	"elia-go/internal/mesh/workspace"
)

// newTrackerWorkspace builds a throwaway workspace on disk. Conflicts are decided
// against real files, so a real directory is the only honest fixture: an
// in-memory fake would let the tracker's own mistakes go unnoticed.
func newTrackerWorkspace(t *testing.T) *workspace.Workspace {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	ws, err := workspace.Create(root, workspace.CreateOptions{AdoptWorkspaceID: testWorkspaceID})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Close() })
	return ws
}

const testWorkspaceID = "ws_9a1b2c"

func writeFile(t *testing.T, ws *workspace.Workspace, rel, content string) {
	t.Helper()
	abs, err := security.SecureJoin(ws.Root, rel)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, ws *workspace.Workspace, rel string) string {
	t.Helper()
	abs, err := security.SecureJoin(ws.Root, rel)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// agree pretends both peers settled on content at a version, which is the state a
// change is then applied to or rejected against.
func agree(t *testing.T, ws *workspace.Workspace, rel, content string, version int64) string {
	t.Helper()
	writeFile(t, ws, rel, content)
	_, hash, err := ws.LocalExists(rel)
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.RecordFile(rel, int64(len(content)), hash, version, "test"); err != nil {
		t.Fatal(err)
	}
	return hash
}

func TestCheckAppliesAnEditBuiltOnTheAgreedVersion(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	base := agree(t, ws, "notes.txt", "one\n", 1)

	change := Change{
		Op:          OpUpdate,
		Path:        "notes.txt",
		BaseVersion: 1,
		Version:     2,
		NewHash:     "theirs-after-edit",
		OldHash:     base,
	}

	d, err := tracker.Check(change)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Apply {
		t.Fatalf("expected the edit to apply, got conflict %+v", d.Conflict)
	}
	if d.Conflict != nil {
		t.Error("an applying decision must not carry a conflict")
	}
}

// The case the whole design exists for: both peers edited the same file from the
// same base. The local edit must survive.
func TestCheckRefusesAnEditWhenTheLocalSideAlsoMoved(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "notes.txt", "agreed\n", 1)

	// The local user edits after the agreement. This is what the store alone
	// cannot see, and the reason LocalExists exists.
	writeFile(t, ws, "notes.txt", "mine\n")

	change := Change{
		Op:          OpUpdate,
		Path:        "notes.txt",
		BaseVersion: 1,
		Version:     2,
		NewHash:     "theirs-after-edit",
	}

	d, err := tracker.Check(change)
	if err != nil {
		t.Fatal(err)
	}
	if d.Apply {
		t.Fatal("an edit built on a base the local side has moved past must not apply")
	}
	if d.Conflict == nil {
		t.Fatal("expected a conflict")
	}
	if d.Conflict.Kind != ConflictBothEdited {
		t.Errorf("kind = %q, want %q", d.Conflict.Kind, ConflictBothEdited)
	}
	if d.Conflict.LocalHash != hashOf(t, ws, "notes.txt") {
		t.Error("the conflict must report the local content that is at stake")
	}
	if got := readFile(t, ws, "notes.txt"); got != "mine\n" {
		t.Errorf("local file was disturbed: %q", got)
	}
}

func hashOf(t *testing.T, ws *workspace.Workspace, rel string) string {
	t.Helper()
	_, h, err := ws.LocalExists(rel)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// A file edited on disk without the version being bumped, which is what happens
// when an editor writes through a path the watcher missed.
func TestCheckRefusesAnEditWhenLocalContentDriftedDespiteTheVersion(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "notes.txt", "agreed\n", 1)
	writeFile(t, ws, "notes.txt", "hand-edited\n")

	d, err := tracker.Check(Change{
		Op:          OpUpdate,
		Path:        "notes.txt",
		BaseVersion: 1,
		Version:     2,
		NewHash:     "theirs",
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.Apply {
		t.Fatal("content drifted from the agreed hash, so the edit must not apply")
	}
	if d.Conflict == nil || d.Conflict.Kind != ConflictBothEdited {
		t.Fatalf("expected a both-edited conflict, got %+v", d.Conflict)
	}
}

func TestCheckAppliesAFileThePeerHasNeverSeen(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)

	d, err := tracker.Check(Change{
		Op:          OpCreate,
		Path:        "fresh.txt",
		BaseVersion: 0,
		Version:     1,
		NewHash:     "hash-of-fresh",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Apply {
		t.Fatalf("a new file has no base to conflict with: %+v", d.Conflict)
	}
}

// A create whose base is non-zero means the file existed, was agreed, and was
// then deleted locally. Re-creating it would resurrect content over a deletion.
func TestCheckTreatsARecreateAfterALocalDeleteAsAConflict(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "gone.txt", "was here\n", 4)
	if err := os.Remove(filepath.Join(ws.Root, "gone.txt")); err != nil {
		t.Fatal(err)
	}

	d, err := tracker.Check(Change{
		Op:          OpCreate,
		Path:        "gone.txt",
		BaseVersion: 4,
		Version:     5,
		NewHash:     "theirs",
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.Apply {
		t.Fatal("a create on top of a local deletion must conflict")
	}
	if d.Conflict == nil || d.Conflict.Kind != ConflictDeleteEdit {
		t.Fatalf("expected a delete-edit conflict, got %+v", d.Conflict)
	}
}

func TestCheckAppliesADeleteWhenTheLocalFileIsUntouched(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "doomed.txt", "goodbye\n", 3)

	d, err := tracker.Check(Change{
		Op:          OpDelete,
		Path:        "doomed.txt",
		BaseVersion: 3,
		Version:     4,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Apply {
		t.Fatalf("an untouched delete should apply: %+v", d.Conflict)
	}
}

func TestCheckTreatsADeleteAsAppliedWhenTheFileIsAlreadyGone(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "doomed.txt", "goodbye\n", 3)
	if err := os.Remove(filepath.Join(ws.Root, "doomed.txt")); err != nil {
		t.Fatal(err)
	}

	d, err := tracker.Check(Change{
		Op:          OpDelete,
		Path:        "doomed.txt",
		BaseVersion: 3,
		Version:     4,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Apply {
		t.Fatal("a delete of an already-absent file is idempotent, not a conflict")
	}
}

// Deleting a file the local user edited would destroy the edit, so it must be
// reported instead.
func TestCheckRefusesADeleteWhenTheLocalFileWasEdited(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "doomed.txt", "original\n", 3)
	writeFile(t, ws, "doomed.txt", "i still want this\n")

	d, err := tracker.Check(Change{
		Op:          OpDelete,
		Path:        "doomed.txt",
		BaseVersion: 3,
		Version:     4,
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.Apply {
		t.Fatal("deleting a locally edited file would destroy the edit")
	}
	if d.Conflict == nil || d.Conflict.Kind != ConflictDeleteEdit {
		t.Fatalf("expected a delete-edit conflict, got %+v", d.Conflict)
	}
}

// A resync and a live patch can carry the same content. Writing it again is
// harmless but causes a pointless write and a watcher event that echoes back.
func TestCheckReportsAlreadyCurrentContent(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "same.txt", "identical\n", 1)
	onDisk := hashOf(t, ws, "same.txt")

	d, err := tracker.Check(Change{
		Op:          OpUpdate,
		Path:        "same.txt",
		BaseVersion: 1,
		Version:     2,
		NewHash:     onDisk,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Apply {
		t.Fatal("identical content should be accepted, not rejected")
	}
	if d.Reason != "already current" {
		t.Errorf("reason = %q, want %q", d.Reason, "already current")
	}
}

func TestBaseReportsZeroForAnUnknownPath(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)

	version, hash, err := tracker.Base("never-seen.txt")
	if err != nil {
		t.Fatal(err)
	}
	if version != 0 {
		t.Errorf("version = %d, want 0", version)
	}
	if hash != "" {
		t.Errorf("hash = %q, want empty", hash)
	}
}

func TestRecordPersistsAConflictForLaterResolution(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)

	id, err := tracker.Record(Conflict{
		Path:          "notes.txt",
		Kind:          ConflictBothEdited,
		BaseVersion:   1,
		LocalVersion:  2,
		RemoteVersion: 2,
		LocalHash:     "a",
		RemoteHash:    "b",
		Kept:          ".workspace-conflicts/notes.txt.host-20240101T000000Z",
	}, "peer-1")
	if err != nil {
		t.Fatal(err)
	}
	if id == 0 {
		t.Fatal("expected a real conflict id")
	}

	rows, err := ws.Store.UnresolvedConflicts()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d unresolved conflicts, want 1", len(rows))
	}
	got := rows[0]
	if got.Path != "notes.txt" || got.PeerID != "peer-1" {
		t.Errorf("unexpected conflict row: %+v", got)
	}
	if !strings.Contains(got.KeptPath, ".workspace-conflicts/") {
		t.Errorf("the preserved copy was not recorded: %q", got.KeptPath)
	}
	if time.Since(got.DetectedAt) > time.Minute {
		t.Error("detection time was not stamped")
	}
}

func TestAdvanceThenCheckTakesTheNewVersionAsTheBase(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "notes.txt", "first\n", 1)

	// Applying a change moves the agreed version forward.
	writeFile(t, ws, "notes.txt", "second\n")
	if err := tracker.Advance("notes.txt", int64(len("second\n")), mustHash(t, ws, "notes.txt"), 2, "peer-1"); err != nil {
		t.Fatal(err)
	}

	d, err := tracker.Check(Change{
		Op:          OpUpdate,
		Path:        "notes.txt",
		BaseVersion: 2,
		Version:     3,
		NewHash:     "third",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Apply {
		t.Fatalf("a change built on the newly agreed version should apply: %+v", d.Conflict)
	}
}

func mustHash(t *testing.T, ws *workspace.Workspace, rel string) string {
	t.Helper()
	return hashOf(t, ws, rel)
}

func TestForgetDropsThePathFromAgreedState(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "temp.txt", "x\n", 1)

	if err := tracker.Forget("temp.txt"); err != nil {
		t.Fatal(err)
	}
	version, _, err := tracker.Base("temp.txt")
	if err != nil {
		t.Fatal(err)
	}
	if version != 0 {
		t.Errorf("version after Forget = %d, want 0", version)
	}
}

// Conflict kinds must match what the store filters on, or a conflict would be
// recorded and then never listed.
func TestConflictKindsMatchTheStoreVocabulary(t *testing.T) {
	rows := []string{ConflictBothEdited, ConflictDeleteEdit, ConflictRemoteNewer}
	for _, kind := range rows {
		found := false
		for _, known := range store.ConflictKinds() {
			if known == kind {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("kind %q is not one the store recognises: %v", kind, store.ConflictKinds())
		}
	}
}

// A local edit that no peer has confirmed is not a base. The version numbers can
// coincide by accident: a member that creates a file locally at version 1 and a
// host that edited an agreed file to version 1 are indistinguishable to a version
// comparison, and applying on that match would destroy the member's unsent work.
func TestCheckRefusesAChangeWhenTheLocalEditIsNotYetAcknowledged(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "pending.txt", "agreed\n", 1)

	// A local edit: the file changes and the row is marked as not yet agreed.
	writeFile(t, ws, "pending.txt", "my unsent work\n")
	if err := ws.RecordFile("pending.txt", 15, mustHash(t, ws, "pending.txt"), 1, workspace.WriterLocal); err != nil {
		t.Fatal(err)
	}
	pending, err := ws.PendingLocal("pending.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !pending {
		t.Fatal("expected the row to be marked as a pending local change")
	}

	// A peer's change built on the same version the local edit happens to sit at.
	d, err := tracker.Check(Change{
		Op:          OpUpdate,
		Path:        "pending.txt",
		BaseVersion: 1,
		Version:     2,
		NewHash:     "theirs",
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.Apply {
		t.Fatal("a peer's change must not be applied over an unacknowledged local edit")
	}
	if d.Conflict == nil || d.Conflict.Kind != ConflictBothEdited {
		t.Fatalf("expected a both-edited conflict, got %+v", d.Conflict)
	}
	if got := readFile(t, ws, "pending.txt"); got != "my unsent work\n" {
		t.Errorf("the local edit was disturbed: %q", got)
	}
}

// Once a peer has accepted the change the row is no longer pending, and the next
// change from that peer applies normally.
func TestAnAcknowledgedChangeIsNoLongerPending(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	writeFile(t, ws, "seq.txt", "one\n")
	if err := ws.RecordFile("seq.txt", 4, mustHash(t, ws, "seq.txt"), 1, workspace.WriterLocal); err != nil {
		t.Fatal(err)
	}
	if pending, err := ws.PendingLocal("seq.txt"); err != nil || !pending {
		t.Fatalf("expected a pending local change, got pending=%v err=%v", pending, err)
	}

	// The peer accepted it, so the row is rewritten with the peer's identity.
	if err := ws.RecordFile("seq.txt", 4, mustHash(t, ws, "seq.txt"), 2, "peer-1"); err != nil {
		t.Fatal(err)
	}
	if pending, err := ws.PendingLocal("seq.txt"); err != nil || pending {
		t.Fatalf("expected no pending change after acknowledgement, got pending=%v err=%v", pending, err)
	}

	d, err := tracker.Check(Change{
		Op:          OpUpdate,
		Path:        "seq.txt",
		BaseVersion: 2,
		Version:     3,
		NewHash:     "next",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Apply {
		t.Fatalf("a change built on the acknowledged version should apply: %+v", d.Conflict)
	}
}

// A resync must not clobber unsent local work either. A peer catching up is not
// entitled to overwrite a change the local side has not had agreed.
func TestCheckResyncRefusesToClobberAnUnacknowledgedLocalEdit(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	writeFile(t, ws, "mine.txt", "agreed\n")
	if err := ws.RecordFile("mine.txt", 7, mustHash(t, ws, "mine.txt"), 1, workspace.WriterLocal); err != nil {
		t.Fatal(err)
	}
	writeFile(t, ws, "mine.txt", "my unsent work\n")

	d, err := tracker.CheckResync(Change{
		Op:          OpUpdate,
		Path:        "mine.txt",
		BaseVersion: 1,
		Version:     2,
		OldHash:     mustHash(t, ws, "mine.txt"),
		NewHash:     "theirs",
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.Apply {
		t.Fatal("a resync must not overwrite an unacknowledged local edit")
	}
}

// The resync case that must succeed: the local file still holds exactly what the
// remote believes both peers agreed on, so the remote's change fast-forwards even
// though the local version is higher.
func TestCheckResyncFastForwardsWhenTheAgreedContentIsStillLocal(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agreed := agree(t, ws, "behind.txt", "agreed\n", 1)

	// The local version is ahead of the remote's base while the content is still
	// exactly what both sides agreed on. This is what a peer looks like after
	// having fast-forwarded through changes that did not alter this file.
	if err := ws.RecordFile("behind.txt", int64(len("agreed\n")), agreed, 4, "peer-1"); err != nil {
		t.Fatal(err)
	}

	d, err := tracker.CheckResync(Change{
		Op:          OpUpdate,
		Path:        "behind.txt",
		BaseVersion: 1,
		Version:     2,
		OldHash:     agreed,
		NewHash:     "theirs",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Apply {
		t.Fatalf("the remote's change sits on the agreed content and should apply: %+v", d.Conflict)
	}
}

// Neither the agreed hash nor the version lines up, so there is no way to show
// the local content is an ancestor of the remote's edit. Reporting a conflict is
// the only safe answer.
func TestCheckResyncConflictsWhenNothingLinesUp(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agree(t, ws, "diverged.txt", "agreed\n", 1)
	writeFile(t, ws, "diverged.txt", "mine, unrelated\n")

	d, err := tracker.CheckResync(Change{
		Op:          OpUpdate,
		Path:        "diverged.txt",
		BaseVersion: 7,
		Version:     8,
		OldHash:     "something-else",
		NewHash:     "theirs",
	})
	if err != nil {
		t.Fatal(err)
	}
	if d.Apply {
		t.Fatal("a resync change that matches nothing must not apply")
	}
	if d.Conflict == nil {
		t.Fatal("expected a conflict")
	}
}

// A delete the peer asked for, where the local file is still what both sides last
// agreed on, applies during a resync even if the versions have drifted.
func TestCheckResyncAppliesADeleteOnTheAgreedContent(t *testing.T) {
	ws := newTrackerWorkspace(t)
	tracker := NewTracker(ws)
	agreed := agree(t, ws, "gone.txt", "agreed\n", 2)

	d, err := tracker.CheckResync(Change{
		Op:          OpDelete,
		Path:        "gone.txt",
		BaseVersion: 2,
		Version:     9,
		OldHash:     agreed,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Apply {
		t.Fatalf("a delete of the agreed content should apply: %+v", d.Conflict)
	}
}
