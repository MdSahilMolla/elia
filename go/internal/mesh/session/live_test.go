package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/workspace"
)

// serveLiveInBackground starts a live hosting session and returns its join code.
//
// A live host is what the tool actually does, so the tests checking ongoing
// synchronisation have to drive it rather than the one-shot path: a test that only
// ever exercises the initial transfer cannot see a change made afterwards.
func serveLiveInBackground(t *testing.T, hostRoot string, onEvent func(sync.Event)) (string, context.CancelFunc) {
	t.Helper()

	host, err := workspace.Create(hostRoot, workspace.CreateOptions{Name: "host"})
	if err != nil {
		t.Fatalf("create host workspace: %v", err)
	}
	t.Cleanup(func() { host.Close() })

	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)

	go func() {
		_, err := Serve(ctx, host, ServeOptions{
			ListenAddr: "127.0.0.1:0",
			CodeTTL:    time.Minute,
			Live:       true,
			OnEvent:    onEvent,
			OnCode: func(_ security.JoinCodePayload, formatted string) {
				select {
				case ready <- firstLine(formatted):
				default:
				}
			},
		})
		if err != nil {
			t.Logf("serve: %v", err)
		}
	}()

	select {
	case code := <-ready:
		if code == "" {
			cancel()
			t.Fatal("no join code")
		}
		return code, cancel
	case <-time.After(10 * time.Second):
		cancel()
		t.Fatal("live host did not print a join code in time")
	}
	return "", cancel
}

// joinLive starts a live member session in the background and returns once its
// initial synchronisation has completed.
func joinLive(t *testing.T, ctx context.Context, root, code string) {
	t.Helper()
	joinLiveDbg(t, ctx, root, code, nil)
}

func joinLiveDbg(t *testing.T, ctx context.Context, root, code string, onEvent func(sync.Event)) {
	t.Helper()
	ready := make(chan error, 1)
	go func() {
		_, _, err := Join(ctx, root, JoinOptions{
			Code:    code,
			Live:    true,
			OnEvent: onEvent,
			OnReady: func(*workspace.Workspace, *sync.SyncReport) { ready <- nil },
		})
		ready <- err
	}()

	select {
	case err := <-ready:
		if err != nil {
			t.Fatalf("join: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("member did not finish its initial synchronisation in time")
	}
}

// The headline behaviour: a file created on the host after the member has joined
// arrives at the member, with no second command and no restart.
func TestAChangeMadeAfterJoiningReachesTheMember(t *testing.T) {
	hostRoot := t.TempDir()
	memberRoot := t.TempDir()

	code, cancelHost := serveLiveInBackground(t, hostRoot, nil)
	defer cancelHost()

	memberCtx, cancelMember := context.WithCancel(context.Background())
	defer cancelMember()
	joinLive(t, memberCtx, memberRoot, code)

	if err := os.WriteFile(filepath.Join(hostRoot, "notes.md"), []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForFileContent(t, memberRoot, "notes.md", "first\n")
}

// The other direction: an edit made on the member reaches the host.
func TestAChangeMadeOnTheMemberReachesTheHost(t *testing.T) {
	hostRoot := t.TempDir()
	memberRoot := t.TempDir()

	if err := os.WriteFile(filepath.Join(hostRoot, "notes.md"), []byte("host\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, cancelHost := serveLiveInBackground(t, hostRoot, nil)
	defer cancelHost()

	memberCtx, cancelMember := context.WithCancel(context.Background())
	defer cancelMember()
	joinLive(t, memberCtx, memberRoot, code)
	waitForFileContent(t, memberRoot, "notes.md", "host\n")

	if err := os.WriteFile(filepath.Join(memberRoot, "notes.md"), []byte("member\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForFileContent(t, hostRoot, "notes.md", "member\n")
}

// A file that only ever existed on the member is new content for the host, and it
// must not be dropped because the host has never heard of it.
func TestANewFileOnTheMemberReachesTheHost(t *testing.T) {
	hostRoot := t.TempDir()
	memberRoot := t.TempDir()

	if err := os.WriteFile(filepath.Join(hostRoot, "host.md"), []byte("host\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, cancelHost := serveLiveInBackground(t, hostRoot, nil)
	defer cancelHost()

	memberCtx, cancelMember := context.WithCancel(context.Background())
	defer cancelMember()
	joinLive(t, memberCtx, memberRoot, code)
	waitForFileContent(t, memberRoot, "host.md", "host\n")

	if err := os.WriteFile(filepath.Join(memberRoot, "mine.md"), []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForFileContent(t, hostRoot, "mine.md", "mine\n")
}

// A delete has to travel too, and it must not leave the file behind.
func TestADeleteOnTheHostReachesTheMember(t *testing.T) {
	hostRoot := t.TempDir()
	memberRoot := t.TempDir()

	if err := os.WriteFile(filepath.Join(hostRoot, "gone.md"), []byte("bye\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, cancelHost := serveLiveInBackground(t, hostRoot, nil)
	defer cancelHost()

	memberCtx, cancelMember := context.WithCancel(context.Background())
	defer cancelMember()
	joinLive(t, memberCtx, memberRoot, code)
	waitForFileContent(t, memberRoot, "gone.md", "bye\n")

	if err := os.Remove(filepath.Join(hostRoot, "gone.md")); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, 20*time.Second, func() bool {
		_, err := os.Stat(filepath.Join(memberRoot, "gone.md"))
		return os.IsNotExist(err)
	})
}

// Simultaneous edits to the same file must not silently pick a winner. Both texts
// have to survive somewhere: overwriting one with the other is exactly the failure
// this design exists to prevent.
func TestConcurrentEditsToTheSameFileArePreservedNotOverwritten(t *testing.T) {
	hostRoot := t.TempDir()
	memberRoot := t.TempDir()

	if err := os.WriteFile(filepath.Join(hostRoot, "shared.md"), []byte("agreed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, cancelHost := serveLiveInBackground(t, hostRoot, nil)
	defer cancelHost()

	memberCtx, cancelMember := context.WithCancel(context.Background())
	defer cancelMember()
	joinLive(t, memberCtx, memberRoot, code)
	waitForFileContent(t, memberRoot, "shared.md", "agreed\n")

	// Both sides edit without having seen the other's change.
	if err := os.WriteFile(filepath.Join(hostRoot, "shared.md"), []byte("the host's version\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(memberRoot, "shared.md"), []byte("the member's version\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The member ends up holding one of the two texts, and the other is preserved
	// beside it. Which one wins the working copy is not specified; losing a text is.
	waitUntil(t, 25*time.Second, func() bool {
		return len(conflictCopiesIn(t, memberRoot)) > 0
	})

	preserved := conflictCopiesIn(t, memberRoot)
	current := mustRead(t, memberRoot, "shared.md")
	for _, want := range []string{"the host's version", "the member's version"} {
		if !anyContains(preserved, want) && !strings.Contains(current, want) {
			t.Errorf("%q was lost: the working copy is %q and the preserved copies are %q",
				want, current, preserved)
		}
	}
}

func waitUntil(t *testing.T, limit time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", limit)
}

func waitForFileContent(t *testing.T, root, name, want string) {
	t.Helper()
	waitUntil(t, 20*time.Second, func() bool {
		return mustRead(t, root, name) == want
	})
}

func mustRead(t *testing.T, root, name string) string {
	t.Helper()
	got, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		return ""
	}
	return string(got)
}

func anyContains(haystacks []string, needle string) bool {
	for _, h := range haystacks {
		if strings.Contains(h, needle) {
			return true
		}
	}
	return false
}

// conflictCopiesIn reads whatever is in the conflict directory of a workspace on
// disk, without opening the database, so a test can assert on real files.
func conflictCopiesIn(t *testing.T, root string) []string {
	t.Helper()
	dir := filepath.Join(root, ".workspace-conflicts")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		got, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err == nil {
			out = append(out, string(got))
		}
	}
	return out
}
