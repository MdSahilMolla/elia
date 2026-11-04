package engine

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"elia-go/internal/mesh/watcher"
)

// agreedWriter returns the last_writer recorded for a path, and whether a row
// exists at all. A deleted path leaves a tombstone, so absence of the file on
// disk is not absence of state.
func agreedWriter(t *testing.T, p *pair, host bool, rel string) (string, bool) {
	t.Helper()
	ws := p.memberWS
	if host {
		ws = p.hostWS
	}
	row, err := ws.Store.GetFile(rel)
	if err != nil {
		return "", false
	}
	return row.LastWriter, true
}

// Applying an incoming delete used to send no Ack, so the node that deleted the
// file kept its tombstone marked as a pending local change forever. Nothing
// cleared it, because no confirmation ever arrived.
func TestAnAppliedDeleteIsConfirmedByThePeer(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "temporary.txt", "scratch\n", 1)

	if err := os.Remove(filepath.Join(p.hostWS.Root, "temporary.txt")); err != nil {
		t.Fatal(err)
	}
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventRemove, Path: "temporary.txt"})
	waitFor(t, 5*time.Second, func() bool { return !exists(t, p.memberWS, "temporary.txt") })

	// The peer applied the delete, so the tombstone is agreed state rather than
	// unsent local work.
	waitFor(t, 5*time.Second, func() bool {
		w, ok := agreedWriter(t, p, true, "temporary.txt")
		return ok && w != "local"
	})
}

// A write after an agreed delete is wrongly refused as a conflict, because the
// version counters diverge across a delete.
//
// The node that applied the delete drops the row entirely (tracker.Forget), so
// its version counter restarts at 1 when it next writes the path, while the node
// that originated the delete still holds a tombstone at version 2. The change is
// therefore offered against a base the other side has moved past.
//
// This is recorded but not yet fixed: making the receiving node keep a tombstone
// would require tombstone-aware manifest and resync handling, because an
// empty-hash row would otherwise be advertised as a real file and could
// resurrect the deleted path. That is a larger change than an Ack fix.
func TestAWriteAfterAnAgreedDeleteIsAppliedNotConflicted(t *testing.T) {
	t.Skip("known defect: version counters diverge across a delete; see the comment above")

	p := newPair(t)
	agree(t, p.hostWS, "temporary.txt", "scratch\n", 1)

	if err := os.Remove(filepath.Join(p.hostWS.Root, "temporary.txt")); err != nil {
		t.Fatal(err)
	}
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventRemove, Path: "temporary.txt"})
	waitFor(t, 5*time.Second, func() bool { return !exists(t, p.memberWS, "temporary.txt") })

	edit(t, p.memberWS, "temporary.txt", "member brings it back\n")
	p.memberWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "temporary.txt"})

	waitForContent(t, p.hostWS, "temporary.txt", "member brings it back\n")
}
