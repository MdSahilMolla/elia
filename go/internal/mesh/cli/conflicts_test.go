package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elia-go/internal/mesh/store"
	"elia-go/internal/mesh/workspace"
)

// conflictFixture builds a workspace with one recorded conflict: a file that
// differs on both sides, with the peer's version preserved beside it.
func conflictFixture(t *testing.T, mine, theirs string) (root string, id int64) {
	t.Helper()
	root = t.TempDir()
	chdir(t, root)

	if _, _, err := run(t, "create", "--name", "conflicted"); err != nil {
		t.Fatalf("create: %v", err)
	}
	ws, err := workspace.Open(".")
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	if err := os.WriteFile(filepath.Join(root, "shared.md"), []byte(mine), 0o644); err != nil {
		t.Fatal(err)
	}
	copy, err := ws.PreserveConflict("shared.md", []byte(theirs), "peer-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	id, err = ws.Store.RecordConflict(store.ConflictRow{
		Path:          "shared.md",
		Kind:          store.ConflictBothEdited,
		BaseVersion:   1,
		LocalVersion:  2,
		RemoteVersion: 2,
		PeerID:        "peer-1",
		KeptPath:      copy.Path,
		DetectedAt:    time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return root, id
}

func TestConflictsListsWhatWasPreserved(t *testing.T) {
	_, id := conflictFixture(t, "my version\n", "their version\n")

	out, _, err := run(t, "conflicts")
	if err != nil {
		t.Fatalf("conflicts: %v", err)
	}
	for _, want := range []string{
		"#" + itoa(id),
		"shared.md",
		"both-edited",
		"peer-1",
		workspace.ConflictDirName,
		"workspace resolve",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("conflicts output missing %q:\n%s", want, out)
		}
	}
}

func TestConflictsIsQuietWhenThereIsNothingToDo(t *testing.T) {
	root := t.TempDir()
	chdir(t, root)
	if _, _, err := run(t, "create"); err != nil {
		t.Fatal(err)
	}
	out, _, err := run(t, "conflicts")
	if err != nil {
		t.Fatalf("conflicts: %v", err)
	}
	if !strings.Contains(out, "No unresolved conflicts") {
		t.Errorf("expected a plain no-conflicts message, got:\n%s", out)
	}
}

// Taking the peer's version is the only option that rewrites the file, and it has
// to actually do so.
func TestResolveKeepTheirsReplacesTheFile(t *testing.T) {
	root, id := conflictFixture(t, "my version\n", "their version\n")

	out, _, err := run(t, "resolve", itoa(id), "--keep-theirs")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !strings.Contains(out, "took their copy") {
		t.Errorf("resolve output missing the decision:\n%s", out)
	}
	got := readFileString(t, filepath.Join(root, "shared.md"))
	if got != "their version\n" {
		t.Errorf("file = %q, want the peer's version", got)
	}

	// A second decision is refused rather than silently overwriting the first.
	if _, _, err := run(t, "resolve", itoa(id), "--keep-mine"); err == nil {
		t.Error("resolving the same conflict twice was allowed")
	}
	out, _, err = run(t, "conflicts")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "No unresolved conflicts") {
		t.Errorf("the resolved conflict is still listed as unresolved:\n%s", out)
	}
}

// Keeping your own version must not touch the file, and must not delete the
// peer's copy either: the whole point of preserving is that it survives until the
// user says otherwise.
func TestResolveKeepMineLeavesBothVersionsOnDisk(t *testing.T) {
	root, id := conflictFixture(t, "my version\n", "their version\n")

	if _, _, err := run(t, "resolve", itoa(id), "--keep-mine"); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got := readFileString(t, filepath.Join(root, "shared.md")); got != "my version\n" {
		t.Errorf("file = %q, want it untouched", got)
	}
	copies := readDirStrings(t, filepath.Join(root, workspace.ConflictDirName))
	if len(copies) != 1 || !strings.Contains(copies[0], "their version") {
		t.Errorf("the preserved copy should still be there, got %q", copies)
	}
}

// --discard is the one option that destroys data, so it must be explicit and
// exact.
func TestResolveDiscardRemovesOnlyTheCopy(t *testing.T) {
	root, id := conflictFixture(t, "my version\n", "their version\n")

	if _, _, err := run(t, "resolve", itoa(id), "--discard"); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got := readFileString(t, filepath.Join(root, "shared.md")); got != "my version\n" {
		t.Errorf("file = %q, want it untouched", got)
	}
	if copies := readDirStrings(t, filepath.Join(root, workspace.ConflictDirName)); len(copies) != 0 {
		t.Errorf("the copy should be gone, found %q", copies)
	}
}

// Keeping both is the manual merge: one file, both texts, and a marker saying
// where the second one came from.
func TestResolveKeepBothJoinsTheTwoVersions(t *testing.T) {
	root, id := conflictFixture(t, "my version\n", "their version\n")

	if _, _, err := run(t, "resolve", itoa(id), "--keep-both"); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	got := readFileString(t, filepath.Join(root, "shared.md"))
	if !strings.Contains(got, "my version") || !strings.Contains(got, "their version") {
		t.Errorf("merged file lost a version: %q", got)
	}
	if strings.Index(got, "my version") > strings.Index(got, "their version") {
		t.Errorf("the local text should come first: %q", got)
	}
}

// A resolution has to be chosen, and only one at a time. Guessing would be worse
// than refusing, because the wrong guess overwrites someone's work.
func TestResolveRequiresExactlyOneDecision(t *testing.T) {
	_, id := conflictFixture(t, "mine\n", "theirs\n")

	if _, _, err := run(t, "resolve", itoa(id)); err == nil {
		t.Error("resolve with no decision was allowed")
	}
	if _, _, err := run(t, "resolve", itoa(id), "--keep-mine", "--keep-theirs"); err == nil {
		t.Error("resolve with two decisions was allowed")
	}
	if _, _, err := run(t, "resolve", "not-a-number", "--keep-mine"); err == nil {
		t.Error("a non-numeric conflict id was accepted")
	}
}

// A conflict id is looked up in the database, so a guess is a miss rather than a
// write to whatever happens to be at that path.
func TestResolveRejectsAnUnknownConflict(t *testing.T) {
	root := t.TempDir()
	chdir(t, root)
	if _, _, err := run(t, "create"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "innocent.md"), []byte("safe\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, "resolve", "9999", "--keep-theirs"); err == nil {
		t.Fatal("an unknown conflict id was accepted")
	}
	if got := readFileString(t, filepath.Join(root, "innocent.md")); got != "safe\n" {
		t.Errorf("an unrelated file was touched: %q", got)
	}
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func readFileString(t *testing.T, path string) string {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(got)
}

func readDirStrings(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read %s: %v", dir, err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, readFileString(t, filepath.Join(dir, e.Name())))
	}
	return out
}
