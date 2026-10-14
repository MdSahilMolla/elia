package engine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"elia-go/internal/mesh/p2p"
	wsync "elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/watcher"
)

// changeCollector gathers structured change events. The engine calls the
// observer from several goroutines, so the collector guards itself.
type changeCollector struct {
	mu     sync.Mutex
	events []wsync.ChangeEvent
}

func (c *changeCollector) observer() wsync.ChangeObserver {
	return func(ev wsync.ChangeEvent) {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.events = append(c.events, ev)
	}
}

func (c *changeCollector) all() []wsync.ChangeEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]wsync.ChangeEvent(nil), c.events...)
}

// forPath returns the events recorded for one path.
func (c *changeCollector) forPath(path string) []wsync.ChangeEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []wsync.ChangeEvent
	for _, ev := range c.events {
		if ev.Path == path {
			out = append(out, ev)
		}
	}
	return out
}

// awaitPath waits for an event for a path and returns the first one.
func (c *changeCollector) awaitPath(t *testing.T, path string, timeout time.Duration) wsync.ChangeEvent {
	t.Helper()
	var found wsync.ChangeEvent
	waitFor(t, timeout, func() bool {
		got := c.forPath(path)
		if len(got) == 0 {
			return false
		}
		found = got[0]
		return true
	})
	return found
}

// observedPair is newPair with structured change observers wired into both
// engines, so a test can assert on what a consumer such as Elia would receive.
//
// hostFiles and memberFiles are written and recorded before the engines attach.
// Both facts matter for the patch path, which is what these tests are about:
//
//   - Timing: the patch baseline cache is seeded when a link attaches, so a file
//     created afterwards has no cached base and its edit travels whole, with no
//     line counts.
//   - Both sides: a patch is applied against local content, so a member that has
//     never seen the file cannot apply one. It asks for the whole file instead,
//     which is correct behaviour and reports no counts. Seeding the member too
//     reproduces the settled state the two nodes are really in after an initial
//     synchronisation.
func observedPair(t *testing.T, hostFiles, memberFiles map[string]string) (*pair, *changeCollector, *changeCollector) {
	t.Helper()
	hostWS := newWorkspace(t, "host")
	memberWS := newWorkspace(t, "member")
	for rel, content := range hostFiles {
		agree(t, hostWS, rel, content, 1)
	}
	for rel, content := range memberFiles {
		agree(t, memberWS, rel, content, 1)
	}
	hostChanges := &changeCollector{}
	memberChanges := &changeCollector{}
	hostWatch := newFakeWatcher()
	memberWatch := newFakeWatcher()

	host, err := New(Config{
		Workspace:      hostWS,
		Mode:           ModeHost,
		Events:         (&collector{}).sink(),
		Changes:        hostChanges.observer(),
		Watcher:        hostWatch,
		PingInterval:   50 * time.Millisecond,
		ResyncInterval: time.Hour,
		ReadTimeout:    2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	member, err := New(Config{
		Workspace:      memberWS,
		Mode:           ModeMember,
		Events:         (&collector{}).sink(),
		Changes:        memberChanges.observer(),
		Watcher:        memberWatch,
		PingInterval:   50 * time.Millisecond,
		ResyncInterval: time.Hour,
		ReadTimeout:    2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := host.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if err := member.Run(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		host.Close()
		member.Close()
	})

	a, b := socketPair(t)
	if err := host.Attach("member", wsync.NewConn(p2p.NewConn(a))); err != nil {
		t.Fatal(err)
	}
	if err := member.Attach("host", wsync.NewConn(p2p.NewConn(b))); err != nil {
		t.Fatal(err)
	}

	p := &pair{
		host: host, member: member,
		hostWS: hostWS, memberWS: memberWS,
		hostEvents: &collector{}, memberEvents: &collector{},
		hostWatch: hostWatch, memberWatch: memberWatch,
	}
	waitFor(t, 2*time.Second, func() bool { return host.peerCount() == 1 && member.peerCount() == 1 })
	return p, hostChanges, memberChanges
}

// patchedContent is a file large enough that a one-line edit travels as a diff
// rather than as a whole file.
//
// The engine only sends a patch when it is smaller than the content, so a tiny
// file edits whole and legitimately carries no line counts. These tests are
// about the patch path, so they need a file where the patch actually wins.
func patchedContent() (before, after string) {
	return strings.Repeat("unchanged line\n", 40), strings.Repeat("unchanged line\n", 39) + "the changed line\n"
}

// A local edit must reach a consumer as a structured event, not only as a
// human-formatted line on the event sink. This is the whole reason the observer
// exists: Elia needs the path, op and hashes without parsing prose.
func TestALocalEditIsReportedStructurally(t *testing.T) {
	before, after := patchedContent()
	p, hostChanges, _ := observedPair(t, map[string]string{"notes.md": before}, map[string]string{"notes.md": before})

	write(t, p.hostWS, "notes.md", after)
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "notes.md"})

	ev := hostChanges.awaitPath(t, "notes.md", 5*time.Second)
	if ev.Op != wsync.OpUpdate {
		t.Fatalf("op = %q, want update", ev.Op)
	}
	if ev.OriginNode != wsync.OriginLocal {
		t.Fatalf("origin = %q, want %q: a local edit is not a peer change", ev.OriginNode, wsync.OriginLocal)
	}
	if ev.Version != 2 {
		t.Fatalf("version = %d, want 2", ev.Version)
	}
	if ev.NewHash == "" {
		t.Fatal("a reported change must carry the new hash; it is the durable record")
	}
	if ev.Added == nil || ev.Removed == nil {
		t.Fatal("a text change sent as a patch must report line counts")
	}
	// The edit replaces the final line, so it reads as one removal and one
	// addition rather than a pure insertion.
	if *ev.Added != 1 || *ev.Removed != 1 {
		t.Fatalf("+%d -%d, want +1 -1", *ev.Added, *ev.Removed)
	}
}

// The receiving side reports the same edit as coming from the peer. Origin
// distinguishes the two directions, which is what lets a consumer tell "I did
// this" from "the other machine did this".
func TestAnAppliedRemoteEditNamesTheOriginatingPeer(t *testing.T) {
	before, after := patchedContent()
	p, _, memberChanges := observedPair(t, map[string]string{"notes.md": before}, map[string]string{"notes.md": before})

	write(t, p.hostWS, "notes.md", after)
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "notes.md"})

	ev := memberChanges.awaitPath(t, "notes.md", 5*time.Second)
	if ev.OriginNode == wsync.OriginLocal {
		t.Fatal("an applied peer change must not be marked local")
	}
	if ev.OriginNode != "host" {
		t.Fatalf("origin = %q, want the peer id %q", ev.OriginNode, "host")
	}
	if ev.Added == nil || *ev.Added != 1 {
		t.Fatalf("the applied patch's line count must survive the wire, got %v", ev.Added)
	}
}

// A whole-file transfer has no diff on the receiving side. The counts must be
// absent rather than zero, or a consumer would record "no lines changed" for a
// change that may have rewritten the file.
func TestAWholeFileTransferOmitsLineCounts(t *testing.T) {
	p, _, memberChanges := observedPair(t, nil, nil)
	agree(t, p.memberWS, "big.txt", strings.Repeat("seed\n", 200), 1)

	// Large enough that the engine prefers the whole file over a patch.
	write(t, p.memberWS, "big.txt", strings.Repeat("replacement\n", 400))
	p.memberWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "big.txt"})

	ev := memberChanges.awaitPath(t, "big.txt", 10*time.Second)
	if ev.Added != nil || ev.Removed != nil {
		t.Fatalf("counts must be absent for a whole-file transfer, got +%v -%v", ev.Added, ev.Removed)
	}
	if ev.Patch != "" {
		t.Fatal("a whole-file transfer has no patch to carry")
	}
	if ev.NewHash == "" {
		t.Fatal("the hash is still required: it is what identifies the new content")
	}
}

// A delete is reported as a delete with no body and no counts. The absence of
// the file is the entire change.
func TestADeleteIsReportedWithoutCounts(t *testing.T) {
	p, _, memberChanges := observedPair(t, nil, nil)
	agree(t, p.hostWS, "temporary.txt", "scratch\n", 1)

	if err := os.Remove(filepath.Join(p.hostWS.Root, "temporary.txt")); err != nil {
		t.Fatal(err)
	}
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventRemove, Path: "temporary.txt"})

	ev := memberChanges.awaitPath(t, "temporary.txt", 5*time.Second)
	if ev.Op != wsync.OpDelete {
		t.Fatalf("op = %q, want delete", ev.Op)
	}
	if ev.Added != nil || ev.Removed != nil || ev.Patch != "" {
		t.Fatalf("a delete must carry no body or counts, got %+v", ev)
	}
	if ev.Conflict {
		t.Fatal("a clean delete is not a conflict")
	}
}

// When both sides edit the same file the change must be reported as a conflict
// rather than as an applied change, and the conflict must carry a reason and the
// preserved copy's location so a consumer can show the user what happened.
func TestAConcurrentEditIsReportedAsAConflict(t *testing.T) {
	p, hostChanges, _ := observedPair(t, nil, nil)
	agree(t, p.hostWS, "clash.txt", "base\n", 1)

	write(t, p.hostWS, "clash.txt", "host edit\n")
	write(t, p.memberWS, "clash.txt", "member edit\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "clash.txt"})
	p.memberWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "clash.txt"})

	waitFor(t, 5*time.Second, func() bool {
		for _, ev := range hostChanges.forPath("clash.txt") {
			if ev.Conflict {
				return true
			}
		}
		return false
	})

	var conflict wsync.ChangeEvent
	for _, ev := range hostChanges.forPath("clash.txt") {
		if ev.Conflict {
			conflict = ev
			break
		}
	}
	if conflict.Reason == "" {
		t.Fatal("a conflict must say why; one a consumer cannot describe is one it cannot show")
	}
	// The conflict is detected on the receiving side, so the change that caused
	// it genuinely came from the peer. Naming it local would tell a consumer the
	// user caused a divergence the other machine actually created.
	if conflict.OriginNode == wsync.OriginLocal {
		t.Fatal("a refused peer change must keep the peer as its origin")
	}
}

// An observer that is not set must not break the engine. Existing callers
// construct an engine without one.
func TestAnEngineRunsWithoutAChangeObserver(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "notes.md", "one\n", 1)
	write(t, p.hostWS, "notes.md", "one\ntwo\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "notes.md"})
	waitFor(t, 5*time.Second, func() bool { return exists(t, p.memberWS, "notes.md") })
}
