package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	stdsync "sync"
	"testing"
	"time"

	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/workspace"
)

// serveInBackground starts a hosting session and returns its join code, so a
// test can drive a member against a real listener on loopback.
func serveInBackground(t *testing.T, hostRoot string, onEvent func(sync.Event)) (string, context.CancelFunc) {
	t.Helper()

	host, err := workspace.Create(hostRoot, workspace.CreateOptions{Name: "host"})
	if err != nil {
		t.Fatalf("create host workspace: %v", err)
	}
	t.Cleanup(func() { host.Close() })

	ctx, cancel := context.WithCancel(context.Background())

	type started struct {
		code string
		err  error
	}
	ready := make(chan started, 1)

	go func() {
		_, err := Serve(ctx, host, ServeOptions{
			ListenAddr: "127.0.0.1:0",
			CodeTTL:    time.Minute,
			OnEvent:    onEvent,
			OnCode: func(_ security.JoinCodePayload, formatted string) {
				select {
				case ready <- started{code: firstLine(formatted)}:
				default:
				}
			},
		})
		ready <- started{err: err}
	}()

	select {
	case s := <-ready:
		if s.err != nil {
			cancel()
			t.Fatalf("serve: %v", s.err)
		}
		return s.code, cancel
	case <-time.After(10 * time.Second):
		cancel()
		t.Fatal("host did not print a join code in time")
		return "", nil
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		abs := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("mkdir for %s: %v", name, err)
		}
		if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
}

func assertFile(t *testing.T, root, name, want string) {
	t.Helper()
	got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if string(got) != want {
		t.Errorf("%s = %q, want %q", name, got, want)
	}
}

func TestJoinPullsTheHostsFiles(t *testing.T) {
	base := t.TempDir()
	hostRoot := filepath.Join(base, "host")
	memberRoot := filepath.Join(base, "member")
	if err := os.MkdirAll(memberRoot, 0o755); err != nil {
		t.Fatal(err)
	}

	files := map[string]string{
		"README.md":     "# shared\n",
		"src/app.py":    "print('hi')\n",
		"src/deep/a.md": "nested\n",
		"empty.txt":     "",
		"big.bin":       strings.Repeat("x", 300000),
	}
	writeTree(t, hostRoot, files)

	var mu stdsync.Mutex
	var hostEvents []string
	code, stopHost := serveInBackground(t, hostRoot, func(e sync.Event) {
		mu.Lock()
		defer mu.Unlock()
		hostEvents = append(hostEvents, string(e.Kind)+": "+e.Message)
	})
	defer stopHost()

	member, report, err := Join(context.Background(), memberRoot, JoinOptions{Code: code})
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	defer member.Close()

	if report.Transferred != len(files) {
		t.Errorf("transferred %d files, want %d", report.Transferred, len(files))
	}
	for name, body := range files {
		assertFile(t, memberRoot, name, body)
	}

	// The member is a member of the host's workspace, and holds the host's id.
	if member.ID != hostIDOf(t, memberRoot) {
		t.Errorf("member workspace id %q differs from its stored id", member.ID)
	}
	if member.Role != workspace.RoleMember {
		t.Errorf("role = %q, want %q", member.Role, workspace.RoleMember)
	}
}

func hostIDOf(t *testing.T, root string) string {
	t.Helper()
	ws, err := workspace.Open(root)
	if err != nil {
		t.Fatalf("reopen member workspace: %v", err)
	}
	defer ws.Close()
	return ws.ID
}

func TestJoinIsIdempotentOnAnAlreadySyncedFolder(t *testing.T) {
	base := t.TempDir()
	hostRoot := filepath.Join(base, "host")
	memberRoot := filepath.Join(base, "member")

	writeTree(t, hostRoot, map[string]string{"a.txt": "one\n", "b.txt": "two\n"})

	code, stopHost := serveInBackground(t, hostRoot, nil)
	defer stopHost()

	// A second code is needed: the first one is single use.
	code = mintSecondCode(t, hostRoot, code)

	first, _, err := Join(context.Background(), memberRoot, JoinOptions{Code: code})
	if err != nil {
		t.Fatalf("first join: %v", err)
	}
	firstID := first.ID
	first.Close()

	// Second pass over the same folder: nothing to transfer, and it must not
	// deadlock waiting on a request that is never sent.
	_, report, err := Join(context.Background(), memberRoot, JoinOptions{Code: code})
	if err != nil {
		t.Fatalf("second join: %v", err)
	}
	if report.Transferred != 0 {
		t.Errorf("second join transferred %d files, want 0", report.Transferred)
	}
	if report.Skipped != 2 {
		t.Errorf("second join skipped %d files, want 2", report.Skipped)
	}

	member, err := workspace.Open(memberRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer member.Close()
	if member.ID != firstID {
		t.Errorf("workspace id changed between joins: %q then %q", firstID, member.ID)
	}
	assertFile(t, memberRoot, "a.txt", "one\n")
}

func TestJoinRejectsAForeignWorkspaceID(t *testing.T) {
	base := t.TempDir()
	hostRoot := filepath.Join(base, "host")
	memberRoot := filepath.Join(base, "member")
	if err := os.MkdirAll(memberRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTree(t, hostRoot, map[string]string{"a.txt": "one\n"})

	// A member folder already belonging to a different workspace.
	other, err := workspace.Create(memberRoot, workspace.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	otherID := other.ID
	other.Close()

	code, stopHost := serveInBackground(t, hostRoot, nil)
	defer stopHost()

	_, _, err = Join(context.Background(), memberRoot, JoinOptions{Code: code})
	if err == nil {
		t.Fatal("join succeeded against a mismatched workspace id")
	}
	if !strings.Contains(err.Error(), otherID) {
		t.Errorf("error %q does not name the local workspace id %q", err, otherID)
	}
}

func TestJoinRejectsAMalformedCode(t *testing.T) {
	memberRoot := filepath.Join(t.TempDir(), "member")
	_, _, err := Join(context.Background(), memberRoot, JoinOptions{Code: "not-a-code"})
	if err == nil {
		t.Fatal("join accepted a malformed code")
	}
}

// mintSecondCode issues another code for the same host by starting a second
// listener, since the vault holds one code per serve call.
func mintSecondCode(t *testing.T, hostRoot, first string) string {
	t.Helper()
	ws, err := workspace.Open(hostRoot)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = Serve(ctx, ws, ServeOptions{
			ListenAddr: "127.0.0.1:0",
			CodeTTL:    time.Minute,
			OnEvent:    func(e sync.Event) { t.Logf("serve2 %s: %s", e.Kind, e.Message) },
			OnCode: func(_ security.JoinCodePayload, formatted string) {
				select {
				case ready <- firstLine(formatted):
				default:
				}
			},
		})
	}()
	// The workspace must outlive Serve: its database is the host's state, and
	// closing it early shows up as "sql: database is closed" mid-handshake.
	t.Cleanup(func() {
		cancel()
		<-done
		ws.Close()
	})

	select {
	case code := <-ready:
		return code
	case <-time.After(10 * time.Second):
		t.Fatal("no second code")
		return ""
	}
}
