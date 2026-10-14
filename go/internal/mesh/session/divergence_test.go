package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/workspace"
)

// TestJoinPreservesALocallyEditedFile is the regression test for the data-loss
// bug: a member that edited a file which the host also changed must keep its own
// copy. Before the three-way diff, the differing hash was classified as missing
// and the host's version overwrote the member's edit with no warning.
func TestJoinPreservesALocallyEditedFile(t *testing.T) {
	base := t.TempDir()
	hostRoot := filepath.Join(base, "host")
	memberRoot := filepath.Join(base, "member")

	writeTree(t, hostRoot, map[string]string{"notes.md": "the host's version\n"})
	writeTree(t, memberRoot, map[string]string{"notes.md": "the member's own work\n"})

	code, cancel := serveInBackground(t, hostRoot, nil)
	defer cancel()

	ctx, cancelJoin := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelJoin()

	ws, report, err := Join(ctx, memberRoot, JoinOptions{Code: code})
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	defer ws.Close()

	if len(report.Divergent) != 1 || report.Divergent[0] != "notes.md" {
		t.Fatalf("Divergent = %v, want [notes.md]", report.Divergent)
	}
	if report.Transferred != 0 {
		t.Errorf("Transferred = %d, want 0: a divergent file must not be fetched", report.Transferred)
	}

	// The member's edit is the whole point: it must survive verbatim.
	assertFile(t, memberRoot, "notes.md", "the member's own work\n")

	// The divergence must be discoverable, not just refused: a conflict row
	// pointing at a preserved copy of the host's version.
	conflicts, err := ws.Store.UnresolvedConflicts()
	if err != nil {
		t.Fatalf("read conflicts: %v", err)
	}
	if len(conflicts) != 1 {
		t.Fatalf("conflicts = %d, want 1", len(conflicts))
	}
	c := conflicts[0]
	if c.Path != "notes.md" {
		t.Errorf("conflict path = %q, want notes.md", c.Path)
	}
	if c.KeptPath == "" {
		t.Error("conflict has no preserved copy of the remote version")
	} else {
		kept := filepath.Join(ws.Root, c.KeptPath)
		if _, err := os.Stat(kept); err != nil {
			t.Errorf("preserved copy %q is not on disk: %v", kept, err)
		}
	}
}

// A file the member has not touched is an ordinary update and must still be
// replaced, or the fix would break normal syncing.
func TestJoinStillReplacesAnUntouchedFile(t *testing.T) {
	base := t.TempDir()
	hostRoot := filepath.Join(base, "host")
	memberRoot := filepath.Join(base, "member")

	writeTree(t, hostRoot, map[string]string{
		"untouched.md": "host v1\n",
		"edited.md":    "host v1\n",
		"new.md":       "brand new\n",
	})
	writeTree(t, memberRoot, map[string]string{
		"untouched.md": "host v1\n",
		"edited.md":    "member edit\n",
	})

	code, cancel := serveInBackground(t, hostRoot, nil)
	defer cancel()

	ctx, cancelJoin := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelJoin()

	ws, report, err := Join(ctx, memberRoot, JoinOptions{Code: code})
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	defer ws.Close()

	// untouched.md is identical on both sides, so nothing to do; edited.md is
	// divergent and untouched; new.md is simply missing.
	if len(report.Divergent) != 1 || report.Divergent[0] != "edited.md" {
		t.Errorf("Divergent = %v, want [edited.md]", report.Divergent)
	}
	assertFile(t, memberRoot, "edited.md", "member edit\n")
	assertFile(t, memberRoot, "new.md", "brand new\n")
}

// With an explicit force, the caller is choosing to take the remote version.
// This is the documented escape hatch, and it must actually work.
func TestJoinForceOverwritesADivergentFile(t *testing.T) {
	base := t.TempDir()
	hostRoot := filepath.Join(base, "host")
	memberRoot := filepath.Join(base, "member")

	writeTree(t, hostRoot, map[string]string{"notes.md": "host wins\n"})
	writeTree(t, memberRoot, map[string]string{"notes.md": "member loses\n"})

	code, cancel := serveInBackground(t, hostRoot, nil)
	defer cancel()

	host, err := workspace.Open(hostRoot)
	if err != nil {
		t.Fatalf("open host: %v", err)
	}
	defer host.Close()

	// A second code is needed because the first was consumed by the pairing
	// above, and ForcePairing is what tells Join to prefer it.
	second := mintSecondCode(t, hostRoot, code)

	ctx, cancelJoin := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelJoin()

	// Reuse the same host workspace under a fresh member folder so the code is
	// still live.
	ws, err := joinForced(t, ctx, memberRoot, second)
	if err != nil {
		t.Fatalf("forced join: %v", err)
	}
	defer ws.Close()

	assertFile(t, memberRoot, "notes.md", "host wins\n")
	if n, err := ws.Store.CountUnresolvedConflicts(); err != nil || n != 0 {
		t.Errorf("unresolved conflicts = %d (err %v), want 0 after a forced overwrite", n, err)
	}
}

// joinForced drives a join with the force flag through the same code path the
// CLI uses.
func joinForced(t *testing.T, ctx context.Context, root, code string) (*workspace.Workspace, error) {
	t.Helper()
	var events []sync.Event
	ws, _, err := JoinWithPolicy(ctx, root, JoinOptions{Code: code, ForcePairing: true},
		workspace.ApplyPolicy{OverwriteDivergent: true, PreserveDivergent: true}, func(e sync.Event) {
			events = append(events, e)
		})
	return ws, err
}
