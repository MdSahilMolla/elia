package workspace

import (
	"strings"
	"testing"

	"elia-go/internal/mesh/store"
)

// An Elia project's state directory holds the live workspace database and the
// trust stores that decide what Elia may do. It is host-side policy rather than
// project content, so a manifest built over an Elia checkout must never offer it
// to a peer.
func TestBuildManifestExcludesEliaState(t *testing.T) {
	root := t.TempDir()

	// Project content that must be shared.
	writeFile(t, root, "src/main.ts", "export const main = 1;")
	writeFile(t, root, "README.md", "# project")

	// Elia state that must never be shared.
	writeFile(t, root, ".elia/policy.json", `{"rules":[]}`)
	writeFile(t, root, ".elia/allow.json", `{"token":"secret"}`)
	writeFile(t, root, ".elia/workspace.sqlite", "sqlite")
	writeFile(t, root, ".elia/workspace.sqlite-wal", "wal")
	writeFile(t, root, ".elia/ledgers/run.log", "log")

	// A nested directory of the same name is matched too, since the rule is a
	// directory matched at any depth.
	writeFile(t, root, "packages/app/.elia/policy.json", `{"rules":[]}`)

	m, _, err := BuildManifest(root, "ws_5b17c4", nil, nil)
	if err != nil {
		t.Fatalf("BuildManifest: %v", err)
	}

	for _, f := range m.Files {
		if f.Path == ".elia" || strings.HasPrefix(f.Path, ".elia/") ||
			strings.Contains(f.Path, "/.elia/") {
			t.Errorf("Elia state %q appeared in the manifest", f.Path)
		}
	}

	want := map[string]bool{"src/main.ts": true, "README.md": true}
	if len(m.Files) != len(want) {
		t.Fatalf("manifest = %v, want only %v", m.Paths(), want)
	}
	for _, f := range m.Files {
		if !want[f.Path] {
			t.Errorf("unexpected manifest entry %q", f.Path)
		}
	}
}

// The rule has to reach the watcher as well as the manifest, or a peer would be
// sent an edit Elia never intended to share.
func TestEliaStateIsIgnoredByPath(t *testing.T) {
	s := DefaultIgnoreSet()
	for _, rel := range []string{
		".elia/policy.json",
		".elia/workspace.sqlite",
		".elia/workspace.sqlite-wal",
		".elia",
		"packages/app/.elia/policy.json",
	} {
		if !s.ShouldIgnore(rel) {
			t.Errorf("ShouldIgnore(%q) = false, want true", rel)
		}
	}
	for _, rel := range []string{"src/main.ts", "README.md", "elia-notes.md", "src/.elitest/x.ts"} {
		if s.ShouldIgnore(rel) {
			t.Errorf("ShouldIgnore(%q) = true, want false", rel)
		}
	}
}

// The Elia state directory must not be silently writable through the same
// validation every other path passes, so confirm it is recognised as the
// tool's own state rather than an ordinary project path.
func TestEliaStateDirIsDeclared(t *testing.T) {
	if EliaStateDirName != ".elia" {
		t.Errorf("EliaStateDirName = %q, want %q", EliaStateDirName, ".elia")
	}
	// A collision would mean the tool's own database and Elia's trust stores
	// shared one directory name, and neither ignore rule could be told apart.
	if EliaStateDirName == store.StateDirName {
		t.Errorf("the tool's own state directory collides with %q", EliaStateDirName)
	}
}

// Elia builds throwaway projects in a top-level workspace/ directory, which its
// .gitignore excludes. Those are machine-local scratch output, so a mesh must not
// offer them to the other machine.
func TestBuildManifestExcludesEliaScratchAtTheRoot(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "src/main.ts", "export const main = 1;")
	writeFile(t, root, "README.md", "# project")
	writeFile(t, root, "workspace/scratch-app/index.js", "// throwaway")
	writeFile(t, root, "workspace/scratch-app/out/bundle.js", "// built")

	m, _, err := BuildManifest(root, "ws_5b17c4", nil, nil)
	if err != nil {
		t.Fatalf("BuildManifest: %v", err)
	}
	for _, f := range m.Files {
		if f.Path == EliaScratchDirName || strings.HasPrefix(f.Path, EliaScratchDirName+"/") {
			t.Errorf("Elia scratch %q appeared in the manifest", f.Path)
		}
	}
	if len(m.Files) != 2 {
		t.Fatalf("manifest = %v, want only src/main.ts and README.md", m.Paths())
	}
}

// The scratch rule must stay anchored to the root. This repository keeps its own
// coordination code in src/workspace/, and a bare name rule would match that and
// silently stop synchronising real project source.
func TestEliaScratchRuleDoesNotMatchANestedWorkspaceDirectory(t *testing.T) {
	s := DefaultIgnoreSet()

	if !s.ShouldIgnore("workspace") {
		t.Error("the root scratch directory itself must be ignored")
	}
	if !s.ShouldIgnore("workspace/scratch-app/index.js") {
		t.Error("content under the root scratch directory must be ignored")
	}

	for _, rel := range []string{
		"src/workspace/panel.ts",
		"src/workspace/index.ts",
		"packages/app/workspace/readme.md",
	} {
		if s.ShouldIgnore(rel) {
			t.Errorf("ShouldIgnore(%q) = true, want false: a nested directory of the same name is real source", rel)
		}
	}
}

// The same exclusion has to reach the watcher as well as the manifest, or an edit
// inside the scratch directory would still be sent to the peer.
func TestEliaScratchIsIgnoredByPath(t *testing.T) {
	s := DefaultIgnoreSet()
	for _, rel := range []string{"workspace", "workspace/scratch-app/index.js"} {
		if !s.ShouldIgnore(rel) {
			t.Errorf("ShouldIgnore(%q) = false, want true", rel)
		}
	}
}
