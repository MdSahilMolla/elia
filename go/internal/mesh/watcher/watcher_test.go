package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"elia-go/internal/mesh/workspace"
)

// startWatcher brings up a watcher with a short debounce, so tests are quick
// without depending on timing luck.
func startWatcher(t *testing.T, root string) (Watcher, <-chan Event, context.CancelFunc) {
	t.Helper()
	w := NewWithOptions(root, Options{
		Debounce: 30 * time.Millisecond,
		Ignore:   workspace.DefaultIgnoreSet(),
	})
	ctx, cancel := context.WithCancel(context.Background())
	if err := w.Start(ctx); err != nil {
		cancel()
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		w.Close()
		cancel()
	})
	return w, w.Events(), cancel
}

// await waits for an event on a path, returning it.
func await(t *testing.T, ch <-chan Event, path string, within time.Duration) Event {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatalf("event stream closed while waiting for %q", path)
			}
			if ev.Path == path {
				return ev
			}
		case <-deadline:
			t.Fatalf("no event for %q within %s", path, within)
		}
	}
}

func TestWatchReportsACreatedFile(t *testing.T) {
	root := t.TempDir()
	_, ch, _ := startWatcher(t, root)

	if err := os.WriteFile(filepath.Join(root, "notes.md"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	ev := await(t, ch, "notes.md", 5*time.Second)
	if ev.Kind != EventCreate {
		t.Errorf("kind = %q, want %q", ev.Kind, EventCreate)
	}
}

// A burst of writes is one logical save, so it must arrive as one event. Without
// debouncing the sync layer would send the same file several times.
func TestWatchDebouncesABurstOfWrites(t *testing.T) {
	root := t.TempDir()
	_, ch, _ := startWatcher(t, root)

	target := filepath.Join(root, "busy.txt")
	for i := 0; i < 10; i++ {
		if err := os.WriteFile(target, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}

	// Wait for the debounced event, then confirm nothing else follows for it.
	await(t, ch, "busy.txt", 5*time.Second)
	select {
	case ev := <-ch:
		if ev.Path == "busy.txt" {
			t.Errorf("a second event for busy.txt arrived; the burst was not debounced: %+v", ev)
		}
	case <-time.After(500 * time.Millisecond):
	}
}

func TestWatchReportsRemoval(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "gone.txt")
	if err := os.WriteFile(target, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The file already existed when the watch started, so it produces no event
	// on its own; the removal is the only change to wait for.
	_, ch, _ := startWatcher(t, root)
	time.Sleep(200 * time.Millisecond)

	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	ev := await(t, ch, "gone.txt", 5*time.Second)
	if ev.Kind != EventRemove {
		t.Errorf("kind = %q, want %q", ev.Kind, EventRemove)
	}
}

// The save-by-rename shape is how most editors persist a file. It must read as a
// write to the sync layer, not as a delete followed by a create of a file the
// layer has never seen.
func TestWatchRenameOverFileReadsAsAWrite(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "doc.md")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	// doc.md pre-exists, so nothing is reported until the save replaces it.
	_, ch, _ := startWatcher(t, root)
	time.Sleep(200 * time.Millisecond)

	tmp := filepath.Join(root, ".doc.md.part")
	if err := os.WriteFile(tmp, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, target); err != nil {
		t.Fatal(err)
	}
	ev := await(t, ch, "doc.md", 5*time.Second)
	if ev.Kind != EventWrite {
		t.Errorf("kind = %q, want %q for a rename over an existing file", ev.Kind, EventWrite)
	}
}

// A file created in a directory that did not exist when the watch started must
// still be seen, which is why new directories are watched recursively.
func TestWatchSeesFilesInNewDirectories(t *testing.T) {
	root := t.TempDir()
	_, ch, _ := startWatcher(t, root)

	deep := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	// Give the directory create event time to be handled and its watch added.
	time.Sleep(200 * time.Millisecond)

	if err := os.WriteFile(filepath.Join(deep, "deep.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	ev := await(t, ch, "a/b/c/deep.txt", 5*time.Second)
	if ev.Kind != EventCreate {
		t.Errorf("kind = %q, want %q", ev.Kind, EventCreate)
	}
}

// Ignored paths must never be reported: the state directory holds the database
// and private keys, and reporting it would mean syncing them.
func TestWatchIgnoresTheStateDirectory(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, ".workspace")
	if err := os.MkdirAll(state, 0o755); err != nil {
		t.Fatal(err)
	}
	_, ch, _ := startWatcher(t, root)

	if err := os.WriteFile(filepath.Join(state, "secret.db"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "visible.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The visible file proves the watcher is live; the secret must never arrive.
	ev := await(t, ch, "visible.txt", 5*time.Second)
	if ev.Path == ".workspace/secret.db" {
		t.Fatalf("reported a file inside the state directory: %+v", ev)
	}
	drain(ch, 300*time.Millisecond)
}

func TestCloseIsSafe(t *testing.T) {
	w := New(t.TempDir())
	if err := w.Close(); err != nil {
		t.Errorf("Close returned %v, want nil", err)
	}
	// A second Close must not panic or error.
	if err := w.Close(); err != nil {
		t.Errorf("second Close returned %v, want nil", err)
	}
}

func TestEventsClosesOnContextCancel(t *testing.T) {
	root := t.TempDir()
	_, ch, cancel := startWatcher(t, root)
	cancel()

	// The stream must end rather than block a consumer forever.
	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, open := <-ch:
			if !open {
				return
			}
		case <-deadline:
			t.Fatal("event stream stayed open after the context was cancelled")
		}
	}
}

func drain(ch <-chan Event, within time.Duration) {
	deadline := time.After(within)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-deadline:
			return
		}
	}
}
