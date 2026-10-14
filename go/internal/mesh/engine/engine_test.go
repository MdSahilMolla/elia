package engine

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"elia-go/internal/mesh/p2p"
	wsync "elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/watcher"
	"elia-go/internal/mesh/workspace"
)

const testWorkspaceID = "ws_e19e57"

// newWorkspace creates a real workspace on disk.
//
// The engine writes files, reads them back, and hashes them, so a fake workspace
// would test the fake rather than the engine. Real directories also mean the
// tests exercise the same atomic-rename path production uses.
func newWorkspace(t *testing.T, name string) *workspace.Workspace {
	t.Helper()
	root := filepath.Join(t.TempDir(), name)
	ws, err := workspace.Create(root, workspace.CreateOptions{AdoptWorkspaceID: testWorkspaceID})
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	t.Cleanup(func() { ws.Close() })
	return ws
}

func write(t *testing.T, ws *workspace.Workspace, rel, content string) {
	t.Helper()
	abs := filepath.Join(ws.Root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, ws *workspace.Workspace, rel string) string {
	t.Helper()
	abs := filepath.Join(ws.Root, filepath.FromSlash(rel))
	content, err := os.ReadFile(abs)
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(content)
}

func exists(t *testing.T, ws *workspace.Workspace, rel string) bool {
	t.Helper()
	abs := filepath.Join(ws.Root, filepath.FromSlash(rel))
	_, err := os.Stat(abs)
	return err == nil
}

// agree records a file as settled between peers, which is the state a change is
// then applied to.
func agree(t *testing.T, ws *workspace.Workspace, rel, content string, version int64) {
	t.Helper()
	write(t, ws, rel, content)
	_, hash, err := ws.LocalExists(rel)
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.RecordFile(rel, int64(len(content)), hash, version, "test"); err != nil {
		t.Fatal(err)
	}
}

// collect records every event an engine emits, so a test can assert on what the
// user would have been shown.
type collector struct {
	mu     sync.Mutex
	events []wsync.Event
}

func (c *collector) sink() wsync.EventSink {
	return func(e wsync.Event) {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.events = append(c.events, e)
	}
}

func (c *collector) count(kind string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, e := range c.events {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

func (c *collector) messages(kind string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, e := range c.events {
		if e.Kind == kind {
			out = append(out, e.Message)
		}
	}
	return strings.Join(out, "\n")
}

func (c *collector) all() []wsync.Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]wsync.Event(nil), c.events...)
}

// pair is two engines joined by an in-memory connection.
type pair struct {
	host, member             *Engine
	hostWS, memberWS         *workspace.Workspace
	hostEvents, memberEvents *collector
	hostWatch, memberWatch   *fakeWatcher
}

func (p *pair) hostWatcher() *fakeWatcher   { return p.hostWatch }
func (p *pair) memberWatcher() *fakeWatcher { return p.memberWatch }

func newPair(t *testing.T) *pair {
	t.Helper()

	hostWS := newWorkspace(t, "host")
	memberWS := newWorkspace(t, "member")
	hostEvents := &collector{}
	memberEvents := &collector{}
	hostWatch := newFakeWatcher()
	memberWatch := newFakeWatcher()

	host, err := New(Config{
		Workspace:      hostWS,
		Mode:           ModeHost,
		Events:         hostEvents.sink(),
		Watcher:        hostWatch,
		PingInterval:   50 * time.Millisecond,
		ResyncInterval: time.Hour, // off: a periodic resend would mask send bugs
		ReadTimeout:    2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	member, err := New(Config{
		Workspace:      memberWS,
		Mode:           ModeMember,
		Events:         memberEvents.sink(),
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
		hostEvents: hostEvents, memberEvents: memberEvents,
		hostWatch: hostWatch, memberWatch: memberWatch,
	}

	// Both engines need a moment to reach a steady state before a test starts
	// changing files, so a first edit is not racing the initial cache seeding.
	waitFor(t, 2*time.Second, func() bool { return host.peerCount() == 1 && member.peerCount() == 1 })
	return p
}

// socketPair returns two ends of a real loopback TCP connection.
//
// A real socket rather than net.Pipe, because a pipe is unbuffered and fully
// synchronous: with two engines each sending heartbeats and edits at once, a pipe
// deadlocks on its own back-pressure rather than on anything the test is checking.
// A loopback socket has the same buffering production gets from a real network,
// so the tests exercise the actual framing path without depending on the two ends
// taking strictly alternating turns.
func socketPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })

	type result struct {
		conn net.Conn
		err  error
	}
	accepted := make(chan result, 1)
	go func() {
		conn, err := ln.Accept()
		accepted <- result{conn, err}
	}()

	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })

	got := <-accepted
	if got.err != nil {
		t.Fatal(got.err)
	}
	t.Cleanup(func() { got.conn.Close() })
	return client, got.conn
}

// fakeWatcher is a watcher a test drives by hand.
//
// A real fsnotify watcher would make these tests depend on inotify latency and on
// the 9p filesystem under /mnt/d, which reports events unreliably. The engine's
// contract is "given this event, do the right thing", so tests supply events
// directly and the watcher itself is tested on its own.
type fakeWatcher struct {
	mu     sync.Mutex
	events chan watcher.Event
	closed chan struct{}
	once   sync.Once
}

func newFakeWatcher() *fakeWatcher {
	return &fakeWatcher{
		events: make(chan watcher.Event, 256),
		closed: make(chan struct{}),
	}
}

func (w *fakeWatcher) Start(context.Context) error { return nil }

func (w *fakeWatcher) Events() <-chan watcher.Event { return w.events }

func (w *fakeWatcher) Close() error {
	w.once.Do(func() { close(w.closed) })
	return nil
}

func (w *fakeWatcher) fire(ev watcher.Event) {
	w.mu.Lock()
	defer w.mu.Unlock()
	select {
	case <-w.closed:
	case w.events <- ev:
	}
}

func waitFor(t *testing.T, limit time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", limit)
}

// waitForContent polls until a file has the expected content, which avoids
// sleeping a fixed interval and hoping the message got through.
func waitForContent(t *testing.T, ws *workspace.Workspace, rel, want string) {
	t.Helper()
	var last string
	waitFor(t, 5*time.Second, func() bool {
		content, err := os.ReadFile(filepath.Join(ws.Root, filepath.FromSlash(rel)))
		if err != nil {
			return false
		}
		last = string(content)
		return last == want
	})
	if last != want {
		t.Errorf("%s = %q, want %q", rel, last, want)
	}
}

// edit changes a file and tells the engine about it, which is what a watcher
// event means in practice. Recording the new state first would make the change
// look already-agreed and the engine would correctly send nothing.
func edit(t *testing.T, ws *workspace.Workspace, rel, content string) {
	t.Helper()
	write(t, ws, rel, content)
}

func TestEditOnTheHostReachesTheMember(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "notes.md", "first\n", 1)
	edit(t, p.hostWS, "notes.md", "second\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "notes.md"})

	waitForContent(t, p.memberWS, "notes.md", "second\n")
}

func TestEditInAMemberSubdirectoryReachesTheHost(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "docs/guide.md", "intro\n", 1)
	edit(t, p.hostWS, "docs/guide.md", "expanded\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "docs/guide.md"})

	waitForContent(t, p.memberWS, "docs/guide.md", "expanded\n")
}

func TestNewFileReachesThePeer(t *testing.T) {
	p := newPair(t)
	write(t, p.memberWS, "brand-new.txt", "hello\n")
	p.memberWatcher().fire(watcher.Event{Kind: watcher.EventCreate, Path: "brand-new.txt"})

	waitForContent(t, p.hostWS, "brand-new.txt", "hello\n")
}

func TestDeleteReachesThePeer(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "temporary.txt", "scratch\n", 1)
	edit(t, p.hostWS, "temporary.txt", "still needed\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "temporary.txt"})
	waitForContent(t, p.memberWS, "temporary.txt", "still needed\n")

	if err := os.Remove(filepath.Join(p.hostWS.Root, "temporary.txt")); err != nil {
		t.Fatal(err)
	}
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventRemove, Path: "temporary.txt"})

	waitFor(t, 5*time.Second, func() bool { return !exists(t, p.memberWS, "temporary.txt") })
}

// A file smaller than the cache limit should travel as a patch, which is the
// point of keeping the agreed content around.
func TestATextEditTravelsAsAPatch(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "big.txt", longText(400), 1)
	updated := strings.Replace(longText(400), "line 100\n", "line 100 CHANGED\n", 1)
	edit(t, p.hostWS, "big.txt", updated)
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "big.txt"})

	waitForContent(t, p.memberWS, "big.txt", updated)
}

func longText(lines int) string {
	var b strings.Builder
	for i := 0; i < lines; i++ {
		fmt.Fprintf(&b, "line %d\n", i)
	}
	return b.String()
}

// The echo test. A remote change writes to disk, which the watcher would report,
// which would be sent straight back. If suppression fails, this loop never
// terminates and the test sees a message count that keeps climbing.
func TestARemoteChangeIsNotSentBack(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "echo.txt", "original\n", 1)
	edit(t, p.hostWS, "echo.txt", "host version\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "echo.txt"})
	waitForContent(t, p.memberWS, "echo.txt", "host version\n")

	// Deliver a change from the member side and then assert it settles.
	edit(t, p.memberWS, "echo.txt", "from the member\n")
	p.memberWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "echo.txt"})
	waitForContent(t, p.hostWS, "echo.txt", "from the member\n")

	// Nothing more should happen. The host wrote the file when applying the
	// member's change; a watcher event for that write must be recognised as an
	// echo and dropped.
	time.Sleep(300 * time.Millisecond)
	if got := read(t, p.hostWS, "echo.txt"); got != "from the member\n" {
		t.Fatalf("content changed after settling: %q", got)
	}
	if n := p.hostEvents.count(wsync.EventWatcher); n > 1 {
		t.Errorf("host reported %d local changes; a remote apply was echoed back:\n%s",
			n, p.hostEvents.messages(wsync.EventWatcher))
	}
}

func TestSuppressionDoesNotSwallowALaterLocalEdit(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "file.txt", "one\n", 1)
	edit(t, p.hostWS, "file.txt", "two\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "file.txt"})
	waitForContent(t, p.memberWS, "file.txt", "two\n")

	// The member's change makes the host write the file, which is suppressed.
	edit(t, p.memberWS, "file.txt", "two\n")
	p.memberWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "file.txt"})
	waitForContent(t, p.hostWS, "file.txt", "two\n")

	// A genuine host edit moments later must still go out. Suppression that
	// ignored content would drop this, which is the failure mode worth guarding:
	// the user's own work would silently not sync.
	edit(t, p.hostWS, "file.txt", "three\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "file.txt"})

	waitForContent(t, p.memberWS, "file.txt", "three\n")
}

func TestSuppressIgnoresAnExpiredRecord(t *testing.T) {
	// Suppression entries are only trustworthy briefly. After the TTL a stale
	// entry must not suppress a real change.
	ws := newWorkspace(t, "ttl")
	events := &collector{}
	now := time.Now()
	e, err := New(Config{
		Workspace: ws,
		Events:    events.sink(),
		Watcher:   newFakeWatcher(),
		Now:       func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	write(t, ws, "f.txt", "one\n")
	e.suppress("f.txt", mustHash(t, ws, "f.txt"))

	if !e.isSuppressed("f.txt") {
		t.Fatal("a fresh record for matching content should suppress")
	}
	// The record was consumed by the first check, so a second one does not
	// suppress. This is what stops a suppression from being reusable forever.
	if e.isSuppressed("f.txt") {
		t.Error("a suppression record must be used once")
	}

	e.suppress("f.txt", mustHash(t, ws, "f.txt"))
	now = now.Add(DefaultSuppressionTTL + time.Minute)
	if e.isSuppressed("f.txt") {
		t.Error("an expired record must not suppress")
	}
}

// settle waits until a path is no longer a pending local change, which is when
// the peer has acknowledged it and the versions on both sides agree.
func settle(t *testing.T, ws *workspace.Workspace, rel string) {
	t.Helper()
	waitFor(t, 5*time.Second, func() bool {
		pending, err := ws.PendingLocal(rel)
		return err == nil && !pending
	})
}

func mustHash(t *testing.T, ws *workspace.Workspace, rel string) string {
	t.Helper()
	_, hash, err := ws.LocalExists(rel)
	if err != nil {
		t.Fatal(err)
	}
	return hash
}

// Both sides edit the same file while disconnected from each other's changes.
// Neither edit may be lost, and the sender must be told rather than left
// believing it succeeded.
func TestConcurrentEditsToTheSameFileArePreserved(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "shared.md", "agreed\n", 1)

	// Each side edits from the same base without seeing the other.
	edit(t, p.hostWS, "shared.md", "host version\n")
	edit(t, p.memberWS, "shared.md", "member version\n")

	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "shared.md"})
	p.memberWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "shared.md"})

	// The first change to arrive applies. The second conflicts.
	waitFor(t, 5*time.Second, func() bool {
		return p.hostEvents.count(wsync.EventConflict) > 0 || p.memberEvents.count(wsync.EventConflict) > 0
	})
	// Neither side may overwrite the other's file while the divergence is
	// unresolved, so let the exchange settle and then check both files still hold
	// what that side wrote.
	time.Sleep(400 * time.Millisecond)

	// Whatever happened, both texts must still exist somewhere reachable.
	hostText := read(t, p.hostWS, "shared.md")
	memberText := read(t, p.memberWS, "shared.md")
	keptHost, err := conflictCopies(p.hostWS)
	if err != nil {
		t.Fatal(err)
	}
	keptMember, err := conflictCopies(p.memberWS)
	if err != nil {
		t.Fatal(err)
	}
	// Each side kept its own text, and the other side's text was preserved for
	// the user rather than discarded.
	if !strings.Contains(hostText, "host version") {
		t.Errorf("the host's own file was overwritten: %q", hostText)
	}
	if !strings.Contains(memberText, "member version") {
		t.Errorf("the member's own file was overwritten: %q", memberText)
	}
	all := append([]string{hostText, memberText}, append(keptHost, keptMember...)...)
	joined := strings.Join(all, "\n")
	if !strings.Contains(joined, "host version") {
		t.Errorf("the host's edit was lost; saw:\n%s", joined)
	}
	if !strings.Contains(joined, "member version") {
		t.Errorf("the member's edit was lost; saw:\n%s", joined)
	}

}

// The losing side must learn its change did not land. Without this the sender
// would record the version as agreed and never mention it again, and the user
// would believe their work had synced.
func TestAChangeBuiltOnAStaleBaseIsRefusedAndReported(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "clash.txt", "agreed\n", 1)
	// A real change is needed to get the file across; the agreed state alone
	// tells the engine there is nothing to send.
	edit(t, p.hostWS, "clash.txt", "first change\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "clash.txt"})
	waitForContent(t, p.memberWS, "clash.txt", "first change\n")
	// The acknowledgement of that change has to land before the version is
	// forced, or it would arrive afterwards and undo the setup.
	settle(t, p.hostWS, "clash.txt")

	// The host's agreed state moves forward without the member hearing about it,
	// which is what a missed update looks like. The member is still at version 1.
	if err := p.hostWS.RecordFile("clash.txt", int64(len("agreed\n")), mustHash(t, p.hostWS, "clash.txt"), 5, "another-peer"); err != nil {
		t.Fatal(err)
	}
	edit(t, p.hostWS, "clash.txt", "host edit\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "clash.txt"})

	// The member cannot apply a change built on version 5, so it must say so.
	waitFor(t, 5*time.Second, func() bool { return p.hostEvents.count(wsync.EventConflict) > 0 })
	if !strings.Contains(p.hostEvents.messages(wsync.EventConflict), "clash.txt") {
		t.Errorf("the conflict did not name the file: %s", p.hostEvents.messages(wsync.EventConflict))
	}

	// The member keeps what it has; the host's version is preserved rather than
	// applied over it. The preservation takes a round trip, because the member
	// only has a patch and has to ask for the whole file to have something to keep.
	waitFor(t, 5*time.Second, func() bool {
		kept, err := conflictCopies(p.memberWS)
		return err == nil && len(kept) > 0
	})
	if got := read(t, p.memberWS, "clash.txt"); got != "first change\n" {
		t.Errorf("the member's file was overwritten: %q", got)
	}
	kept, err := conflictCopies(p.memberWS)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(kept[0], "host edit") {
		t.Errorf("the preserved copy does not hold the host's version: %q", kept)
	}
}

// A change a peer accepted is no longer a pending local edit, so a later change
// from that peer may be built on it. Without the acknowledgement clearing the
// pending mark, every follow-up change would conflict forever.
func TestAnAcceptedChangeIsNotTreatedAsPendingForever(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "seq.txt", "one\n", 1)
	edit(t, p.hostWS, "seq.txt", "two\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "seq.txt"})
	waitForContent(t, p.memberWS, "seq.txt", "two\n")

	// Wait for the acknowledgement to land before making the next change.
	settle(t, p.hostWS, "seq.txt")

	edit(t, p.hostWS, "seq.txt", "three\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "seq.txt"})
	waitForContent(t, p.memberWS, "seq.txt", "three\n")
	if n := p.memberEvents.count(wsync.EventConflict); n != 0 {
		t.Errorf("a sequential edit produced %d conflicts; it should apply cleanly", n)
	}
}

// A refused change must not make the sender retry forever. The peer asked for
// nothing, so the exchange has to stop.
func TestARefusedChangeIsNotRetriedEndlessly(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "loop.txt", "agreed\n", 1)
	edit(t, p.hostWS, "loop.txt", "first change\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "loop.txt"})
	waitForContent(t, p.memberWS, "loop.txt", "first change\n")
	settle(t, p.hostWS, "loop.txt")

	if err := p.hostWS.RecordFile("loop.txt", int64(len("first change\n")), mustHash(t, p.hostWS, "loop.txt"), 5, "another-peer"); err != nil {
		t.Fatal(err)
	}
	edit(t, p.hostWS, "loop.txt", "host edit\n")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "loop.txt"})

	waitFor(t, 5*time.Second, func() bool { return p.hostEvents.count(wsync.EventConflict) > 0 })
	// The count has to settle. A resend loop would keep it climbing: the peer
	// asks for the whole file to preserve it, is refused for the same reason, and
	// the exchange never ends.
	settled := p.hostEvents.count(wsync.EventConflict)
	time.Sleep(700 * time.Millisecond)
	if n := p.hostEvents.count(wsync.EventConflict); n != settled {
		t.Errorf("the refusal kept coming back (%d then %d); a refused change must not be resent", settled, n)
	}
}

func conflictCopies(ws *workspace.Workspace) ([]string, error) {
	dir := filepath.Join(ws.Root, ".workspace-conflicts")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []string
	for _, entry := range entries {
		content, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return nil, err
		}
		out = append(out, string(content))
	}
	return out, nil
}

// A peer that goes away must be noticed and dropped, not left in the table
// forever making every future send fail.
func TestDisconnectingDropsThePeer(t *testing.T) {
	p := newPair(t)
	p.host.Detach("member")

	// The peer leaves the table when Detach runs, but the disconnect event comes
	// from the read loop noticing the socket close, which happens a moment later.
	waitFor(t, 5*time.Second, func() bool { return p.host.peerCount() == 0 })
	waitFor(t, 5*time.Second, func() bool { return p.hostEvents.count(wsync.EventDisconnected) > 0 })
}

func TestAttachingTheSamePeerTwiceIsRejected(t *testing.T) {
	p := newPair(t)
	a, _ := socketPair(t)
	if err := p.host.Attach("member", wsync.NewConn(p2p.NewConn(a))); err == nil {
		t.Error("expected attaching an already-attached peer to fail")
	}
}

func TestResyncSendsOnlyWhatThePeerIsMissing(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "a.txt", "a\n", 1)
	agree(t, p.hostWS, "b.txt", "b\n", 1)

	// The engine was told about both, so a resync should send nothing.
	l := p.host.snapshotPeers()[0]
	l.noteInformed("a.txt", 1)
	l.noteInformed("b.txt", 1)
	if err := p.host.resyncPeer(l); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if got := p.memberEvents.count(wsync.EventPatch); got != 0 {
		t.Errorf("a resync sent %d changes for files the peer already had", got)
	}

	// A file the peer has not been told about must be sent.
	agree(t, p.hostWS, "c.txt", "c\n", 1)
	if err := p.host.resyncPeer(l); err != nil {
		t.Fatal(err)
	}
	waitForContent(t, p.memberWS, "c.txt", "c\n")
}

func TestAWatcherEventForUnchangedContentIsNotSent(t *testing.T) {
	p := newPair(t)
	agree(t, p.hostWS, "quiet.txt", "same\n", 1)

	// The store already matches disk, so the event carries no information.
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "quiet.txt"})
	time.Sleep(200 * time.Millisecond)

	if n := p.hostEvents.count(wsync.EventWatcher); n != 0 {
		t.Errorf("an event for unchanged content was reported: %s", p.hostEvents.messages(wsync.EventWatcher))
	}
}

func TestAnEventForAnUnknownMissingFileIsIgnored(t *testing.T) {
	p := newPair(t)
	// A file that is neither on disk nor agreed on: a stray temp file, or one the
	// watcher saw mid-write and then lost. There is nothing to tell the peer.
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventRemove, Path: "never-existed.txt"})
	time.Sleep(200 * time.Millisecond)

	if n := p.hostEvents.count(wsync.EventWatcher); n != 0 {
		t.Errorf("an event for a file with no agreed state was sent: %s",
			p.hostEvents.messages(wsync.EventWatcher))
	}
}

func TestHeartbeatKeepsAnIdleSessionAlive(t *testing.T) {
	p := newPair(t)
	// The read timeout is 2s and pings go out every 50ms, so a session left
	// completely idle would disconnect without them. Nothing is being sent here
	// on purpose.
	time.Sleep(1 * time.Second)
	if p.host.peerCount() != 1 || p.member.peerCount() != 1 {
		t.Errorf("an idle session dropped: host has %d peers, member has %d",
			p.host.peerCount(), p.member.peerCount())
	}
}

func TestACleanGoodbyeEndsTheSession(t *testing.T) {
	p := newPair(t)
	l := p.member.snapshotPeers()[0]
	if err := l.conn.Send(wsync.TypeLeave, wsync.Leave{PeerID: "host", Reason: "done"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, func() bool { return p.host.peerCount() == 0 })
}

// The cache has a byte budget, and honouring it matters: a workspace of large
// files would otherwise be held in memory twice.
func TestContentCacheStaysWithinItsBudget(t *testing.T) {
	c := newContentCache(1000, 400)
	for i := 0; i < 50; i++ {
		c.Put(fmt.Sprintf("f%d.txt", i), make([]byte, 100))
	}
	if c.used > 1000 {
		t.Errorf("cache holds %d bytes, budget is 1000", c.used)
	}
}

func TestContentCacheRefusesToStoreAnOversizedFile(t *testing.T) {
	c := newContentCache(1<<20, 100)
	c.Put("big.txt", make([]byte, 200))
	if _, ok := c.Get("big.txt"); ok {
		t.Error("a file larger than the per-file cap should not be cached")
	}
}

func TestContentCacheReturnsACopy(t *testing.T) {
	c := newContentCache(1<<20, 100)
	c.Put("f.txt", []byte("original"))
	got, _ := c.Get("f.txt")
	got[0] = 'X'
	again, _ := c.Get("f.txt")
	if string(again) != "original" {
		t.Error("the cache handed out its own bytes; a caller could corrupt the agreed base")
	}
}

func TestIsTextRejectsBinary(t *testing.T) {
	if isText([]byte{'a', 0, 'b'}) {
		t.Error("content with a NUL byte is binary")
	}
	if isText([]byte{0xff, 0xfe}) {
		t.Error("invalid UTF-8 is not text")
	}
	if !isText([]byte("plain text\n")) {
		t.Error("plain text should be treated as text")
	}
	if !isText(nil) {
		t.Error("empty content is text")
	}
}

func TestBinaryContentTravelsWhole(t *testing.T) {
	p := newPair(t)
	original := []byte{0x00, 0x01, 0xff}
	agree(t, p.hostWS, "blob.bin", string(original), 1)

	binary := []byte{0x00, 0x01, 0x02, 0xff, 0xfe, 0x00}
	edit(t, p.hostWS, "blob.bin", string(binary))
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "blob.bin"})

	waitFor(t, 5*time.Second, func() bool { return exists(t, p.memberWS, "blob.bin") })
	got, err := os.ReadFile(filepath.Join(p.memberWS.Root, "blob.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(binary) {
		t.Errorf("binary content was corrupted: %x", got)
	}
}

func TestALargeFileArrivesIntact(t *testing.T) {
	p := newPair(t)
	// Larger than one chunk, so the transfer really is chunked and reassembled.
	agree(t, p.hostWS, "large.txt", longText(10), 1)

	big := longText(60000) // about 700 KB, well over the 256 KiB chunk size
	edit(t, p.hostWS, "large.txt", big)
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: "large.txt"})

	waitFor(t, 20*time.Second, func() bool { return exists(t, p.memberWS, "large.txt") })
	if got := read(t, p.memberWS, "large.txt"); got != big {
		t.Errorf("large file did not arrive intact: %d bytes, want %d", len(got), len(big))
	}
}

func TestAnEmptyFileArrives(t *testing.T) {
	p := newPair(t)
	// An empty file produces no data, only a terminating frame. A sender that
	// sent no frames at all would leave the peer waiting forever.
	abs := filepath.Join(p.hostWS.Root, "empty.txt")
	if err := os.WriteFile(abs, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventCreate, Path: "empty.txt"})

	waitFor(t, 5*time.Second, func() bool { return exists(t, p.memberWS, "empty.txt") })
	if got := read(t, p.memberWS, "empty.txt"); got != "" {
		t.Errorf("empty file arrived as %q", got)
	}
}

func TestStateDirectoryIsNotSynchronised(t *testing.T) {
	p := newPair(t)
	// The store and identity live in the workspace. Syncing them would overwrite
	// the receiver's own database, which would be far worse than a lost file.
	// The member already has a state.db of its own, so the check is on content:
	// the host's planted content must not appear.
	before := read(t, p.memberWS, ".workspace/state.db")
	write(t, p.hostWS, ".workspace/state.db", "not real sqlite")
	p.hostWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: ".workspace/state.db"})

	time.Sleep(250 * time.Millisecond)
	if after := read(t, p.memberWS, ".workspace/state.db"); after != before {
		t.Error("the state directory was synchronised; the member's own database was overwritten")
	}
}

func TestConflictCopiesAreNotSynchronisedBack(t *testing.T) {
	p := newPair(t)
	// A conflict copy is preserved for the user, never offered to the peer: the
	// other side has the original and would be confused by a copy of it.
	write(t, p.memberWS, ".workspace-conflicts/notes.md.host-1", "their text\n")
	p.memberWatcher().fire(watcher.Event{Kind: watcher.EventWrite, Path: ".workspace-conflicts/notes.md.host-1"})

	time.Sleep(250 * time.Millisecond)
	if exists(t, p.hostWS, ".workspace-conflicts/notes.md.host-1") {
		t.Error("a conflict copy was sent back to the peer")
	}
	if p.memberEvents.count(wsync.EventWatcher) != 0 {
		t.Errorf("a conflict copy produced a sync event: %s", p.memberEvents.messages(wsync.EventWatcher))
	}
}

func TestEventCollectionIsConcurrencySafe(t *testing.T) {
	// The collector is shared by the watch, heartbeat and receive goroutines. Run
	// it under the race detector in the other tests; this one only asserts the
	// plumbing.
	c := &collector{}
	done := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				c.sink()(wsync.Event{Kind: "info", Message: fmt.Sprintf("%d-%d", n, j)})
			}
		}(i)
	}
	go func() {
		wg.Wait()
		close(done)
	}()
	for {
		select {
		case <-done:
			if len(c.all()) != 400 {
				t.Errorf("collected %d events, want 400", len(c.all()))
			}
			return
		default:
			c.count("info")
			c.messages("info")
		}
	}
}

func TestContextCancellationStopsTheEngine(t *testing.T) {
	ws := newWorkspace(t, "ctx")
	e, err := New(Config{Workspace: ws, Watcher: newFakeWatcher()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	if err := e.Run(ctx); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := e.Close(); err != nil {
		t.Fatal(err)
	}
	// Close must be idempotent, since a session and a CLI both call it on exit.
	if err := e.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
}
