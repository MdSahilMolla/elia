package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBuildManifest(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "README.md", "# hello")
	writeFile(t, root, "src/app.py", "print('x')")
	writeFile(t, root, "src/utils.py", "pass")

	m, skipped, err := BuildManifest(root, "ws_83f92a", nil, nil)
	if err != nil {
		t.Fatalf("BuildManifest: %v", err)
	}
	if len(skipped) != 0 {
		t.Errorf("skipped = %v, want none", skipped)
	}
	if len(m.Files) != 3 {
		t.Fatalf("manifest has %d files, want 3: %+v", len(m.Files), m.Files)
	}

	// Sorted by path, so manifests are comparable.
	want := []string{"README.md", "src/app.py", "src/utils.py"}
	for i, w := range want {
		if m.Files[i].Path != w {
			t.Errorf("file %d = %q, want %q", i, m.Files[i].Path, w)
		}
	}
	for _, f := range m.Files {
		if f.Size <= 0 {
			t.Errorf("%s has size %d", f.Path, f.Size)
		}
		if len(f.Hash) != 64 {
			t.Errorf("%s hash length = %d, want 64", f.Path, len(f.Hash))
		}
		if f.Version != 1 {
			t.Errorf("%s version = %d, want 1", f.Path, f.Version)
		}
	}
}

func TestBuildManifestAppliesIgnoreRules(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "keep.txt", "keep")
	writeFile(t, root, ".git/config", "gitdata")
	writeFile(t, root, "node_modules/pkg/index.js", "js")
	writeFile(t, root, ".workspace/state.db", "private")
	writeFile(t, root, "backup~", "temp")
	writeFile(t, root, "vim.swp", "temp")
	writeFile(t, root, ".DS_Store", "junk")
	writeFile(t, root, "src/keep.py", "keep")

	m, _, err := BuildManifest(root, "ws_83f92a", nil, nil)
	if err != nil {
		t.Fatalf("BuildManifest: %v", err)
	}
	for _, f := range m.Files {
		switch f.Path {
		case ".git/config", "node_modules/pkg/index.js", ".workspace/state.db",
			"backup~", "vim.swp", ".DS_Store":
			t.Errorf("ignored path %q appeared in the manifest", f.Path)
		}
	}
	if len(m.Files) != 2 {
		t.Errorf("manifest = %+v, want only the two keep files", m.Paths())
	}
}

func TestBuildManifestSkipsSymlinks(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "workspace")
	outside := filepath.Join(base, "secret.txt")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeFile(t, root, "real.txt", "real")
	if err := os.Symlink(outside, filepath.Join(root, "link.txt")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	m, skipped, err := BuildManifest(root, "ws_83f92a", nil, nil)
	if err != nil {
		t.Fatalf("BuildManifest: %v", err)
	}
	if m.Has("link.txt") {
		t.Error("symlink was included in the manifest")
	}
	if len(skipped) == 0 {
		t.Error("skipping a symlink was not reported")
	}
	if len(m.Files) != 1 || m.Files[0].Path != "real.txt" {
		t.Errorf("manifest = %v, want only real.txt", m.Paths())
	}
}

func TestBuildManifestVersions(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.txt", "a")
	writeFile(t, root, "b.txt", "b")

	versions := map[string]int64{"a.txt": 7, "b.txt": 1}
	m, _, err := BuildManifest(root, "ws_83f92a", versions, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range m.Files {
		if f.Path == "a.txt" && f.Version != 7 {
			t.Errorf("a.txt version = %d, want 7", f.Version)
		}
		if f.Path == "b.txt" && f.Version != 1 {
			t.Errorf("b.txt version = %d, want 1", f.Version)
		}
	}
}

func TestBuildManifestEmpty(t *testing.T) {
	m, _, err := BuildManifest(t.TempDir(), "ws_83f92a", nil, nil)
	if err != nil {
		t.Fatalf("BuildManifest: %v", err)
	}
	if len(m.Files) != 0 {
		t.Errorf("empty workspace produced %d files", len(m.Files))
	}
	if m.TotalSize() != 0 {
		t.Errorf("TotalSize = %d, want 0", m.TotalSize())
	}
}

func TestManifestLookupAndPaths(t *testing.T) {
	m := &Manifest{Files: []FileEntry{{Path: "a"}, {Path: "b/c"}}}
	if _, ok := m.Lookup("b/c"); !ok {
		t.Error("Lookup(b/c) failed")
	}
	if _, ok := m.Lookup("nope"); ok {
		t.Error("Lookup(nope) succeeded")
	}
	if !m.Has("a") {
		t.Error("Has(a) = false")
	}
	if got := m.Paths(); len(got) != 2 || got[0] != "a" || got[1] != "b/c" {
		t.Errorf("Paths = %v", got)
	}
	if m.TotalSize() != 0 {
		t.Errorf("TotalSize = %d, want 0", m.TotalSize())
	}
}

func TestDiff(t *testing.T) {
	remote := &Manifest{Files: []FileEntry{
		{Path: "same.txt", Hash: "h1"},
		{Path: "changed.txt", Hash: "h2"},
		{Path: "missing.txt", Hash: "h3"},
	}}
	local := map[string]FileEntry{
		"same.txt":      {Path: "same.txt", Hash: "h1"},
		"changed.txt":   {Path: "changed.txt", Hash: "old"},
		"localonly.txt": {Path: "localonly.txt", Hash: "h9"},
	}
	// The local copy of changed.txt still matches the last agreement, so the
	// remote's new hash is an ordinary update rather than a divergence.
	base := map[string]FileEntry{
		"same.txt":    {Path: "same.txt", Hash: "h1"},
		"changed.txt": {Path: "changed.txt", Hash: "old"},
	}

	got := Diff(remote, local, base)
	if len(got.Missing) != 1 || got.Missing[0] != "missing.txt" {
		t.Errorf("missing = %v, want [missing.txt]", got.Missing)
	}
	if len(got.Stale) != 1 || got.Stale[0] != "changed.txt" {
		t.Errorf("stale = %v, want [changed.txt]", got.Stale)
	}
	if len(got.Divergent) != 0 {
		t.Errorf("divergent = %v, want none", got.Divergent)
	}
	if len(got.LocalOnly) != 1 || got.LocalOnly[0] != "localonly.txt" {
		t.Errorf("localOnly = %v, want [localonly.txt]", got.LocalOnly)
	}
}

// A file edited on both sides is the case that used to be silently overwritten.
// It must be reported as divergent and must not be requested unless the caller
// explicitly forces it.
func TestDiffReportsDivergentInsteadOfOverwriting(t *testing.T) {
	remote := &Manifest{Files: []FileEntry{{Path: "notes.md", Hash: "host-version"}}}
	local := map[string]FileEntry{
		"notes.md": {Path: "notes.md", Hash: "member-version"},
	}
	base := map[string]FileEntry{
		"notes.md": {Path: "notes.md", Hash: "agreed-version"},
	}

	got := Diff(remote, local, base)
	if len(got.Divergent) != 1 || got.Divergent[0] != "notes.md" {
		t.Fatalf("divergent = %v, want [notes.md]", got.Divergent)
	}
	if len(got.Stale) != 0 || len(got.Missing) != 0 {
		t.Errorf("stale = %v, missing = %v; a divergent file must appear in neither", got.Stale, got.Missing)
	}
	if need := got.Needs(DefaultApplyPolicy()); len(need) != 0 {
		t.Errorf("default policy would fetch %v; a divergent file must not be fetched", need)
	}
	forced := ApplyPolicy{OverwriteDivergent: true, PreserveDivergent: true}
	if need := got.Needs(forced); len(need) != 1 || need[0] != "notes.md" {
		t.Errorf("forced policy would fetch %v, want [notes.md]", need)
	}
}

// With no recorded base, every mismatch is treated as divergent. This is what
// protects a first join into a folder that already has files.
func TestDiffWithoutBaseTreatsMismatchAsDivergent(t *testing.T) {
	remote := &Manifest{Files: []FileEntry{{Path: "a.txt", Hash: "remote"}}}
	local := map[string]FileEntry{"a.txt": {Path: "a.txt", Hash: "local"}}

	got := Diff(remote, local, nil)
	if len(got.Divergent) != 1 {
		t.Fatalf("divergent = %v, want [a.txt]", got.Divergent)
	}
	if len(got.Stale) != 0 {
		t.Errorf("stale = %v, want none without a known base", got.Stale)
	}
}

func TestDiffWithEmptyLocal(t *testing.T) {
	remote := &Manifest{Files: []FileEntry{{Path: "a"}, {Path: "b"}}}
	got := Diff(remote, map[string]FileEntry{}, nil)
	if len(got.Missing) != 2 {
		t.Errorf("missing = %v, want both files", got.Missing)
	}
	if len(got.LocalOnly) != 0 {
		t.Errorf("localOnly = %v, want none", got.LocalOnly)
	}
}

func TestLocalEntries(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.txt", "a")
	writeFile(t, root, "sub/b.txt", "b")
	writeFile(t, root, ".git/config", "ignored")

	entries, err := LocalEntries(root, nil)
	if err != nil {
		t.Fatalf("LocalEntries: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %d, want 2: %v", len(entries), entries)
	}
	if _, ok := entries["sub/b.txt"]; !ok {
		t.Error("nested file missing from local entries")
	}
	if len(entries["a.txt"].Hash) != 64 {
		t.Errorf("hash length = %d, want 64", len(entries["a.txt"].Hash))
	}
}

func TestHashFileMatchesHashBytes(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.txt", "content")

	got, err := HashFile(filepath.Join(root, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if want := HashBytes([]byte("content")); got != want {
		t.Errorf("HashFile = %s, HashBytes = %s", got, want)
	}
}

func TestIgnoreSet(t *testing.T) {
	ig := DefaultIgnoreSet()

	ignored := []string{
		".workspace/state.db",
		".git/objects/ab/cd",
		"node_modules/left-pad/index.js",
		"deep/node_modules/x.js",
		"file~",
		"notes.swp",
		"partial.tmp",
		".DS_Store",
		"src/.DS_Store",
		"Thumbs.db",
		ConflictDirName,
		"src/" + ConflictDirName + "/notes.md.host-20260101T101010Z-abcd1234",
	}
	for _, p := range ignored {
		if !ig.ShouldIgnore(p) {
			t.Errorf("ShouldIgnore(%q) = false, want true", p)
		}
	}

	kept := []string{
		"README.md",
		"src/app.py",
		"src/main.test.js",
		"notes.txt",
		"a.tmpfile",
		"my~file",
	}
	for _, p := range kept {
		if ig.ShouldIgnore(p) {
			t.Errorf("ShouldIgnore(%q) = true, want false", p)
		}
	}
}

func TestIgnoreSetEmptyPath(t *testing.T) {
	if !DefaultIgnoreSet().ShouldIgnore("") {
		t.Error("the empty path should be ignored")
	}
}
