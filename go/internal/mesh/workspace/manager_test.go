package workspace

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/store"
)

func TestCreate(t *testing.T) {
	root := filepath.Join(t.TempDir(), "project")
	ws, err := Create(root, CreateOptions{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer ws.Close()

	if err := security.ValidateWorkspaceID(ws.ID); err != nil {
		t.Errorf("workspace id %q invalid: %v", ws.ID, err)
	}
	if err := security.ValidatePeerID(ws.PeerID); err != nil {
		t.Errorf("peer id %q invalid: %v", ws.PeerID, err)
	}
	if ws.Role != RoleHost {
		t.Errorf("Role = %q, want %q", ws.Role, RoleHost)
	}
	if ws.Name != "project" {
		t.Errorf("Name = %q, want project", ws.Name)
	}
	if !Exists(root) {
		t.Error("Exists = false after Create")
	}

	// The identity must exist and be usable right after create, so serve
	// cannot fail later for a permissions reason.
	fp, err := ws.FingerprintHex()
	if err != nil {
		t.Fatalf("FingerprintHex: %v", err)
	}
	if len(fp) != 64 {
		t.Errorf("fingerprint length = %d, want 64 hex chars", len(fp))
	}
}

func TestCreateIsIdempotentlyRejected(t *testing.T) {
	root := t.TempDir()
	ws, err := Create(root, CreateOptions{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	ws.Close()

	if _, err := Create(root, CreateOptions{}); err == nil {
		t.Error("Create on an existing workspace succeeded, want rejection")
	}
}

func TestCreateWithName(t *testing.T) {
	root := t.TempDir()
	ws, err := Create(root, CreateOptions{Name: "My Project"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer ws.Close()

	if ws.Name != "My Project" {
		t.Errorf("Name = %q, want %q", ws.Name, "My Project")
	}
	reopened, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reopened.Close()
	if reopened.Name != "My Project" {
		t.Errorf("name did not persist: %q", reopened.Name)
	}
}

func TestOpenMissing(t *testing.T) {
	if _, err := Open(t.TempDir()); err == nil {
		t.Error("Open on a non-workspace succeeded, want error")
	}
}

func TestOpenPreservesIdentity(t *testing.T) {
	root := t.TempDir()
	ws, err := Create(root, CreateOptions{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	fpBefore, _ := ws.FingerprintHex()
	ws.Close()

	reopened, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reopened.Close()
	fpAfter, err := reopened.FingerprintHex()
	if err != nil {
		t.Fatal(err)
	}
	if fpBefore != fpAfter {
		t.Error("identity changed across close and reopen")
	}
}

func TestSetRole(t *testing.T) {
	ws, err := Create(t.TempDir(), CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	if err := ws.SetRole(RoleMember); err != nil {
		t.Fatalf("SetRole: %v", err)
	}
	if ws.Role != RoleMember {
		t.Errorf("Role = %q, want member", ws.Role)
	}
	role, _ := ws.GetMeta(MetaRole)
	if role != RoleMember {
		t.Errorf("persisted role = %q, want member", role)
	}
	if err := ws.SetRole("admin"); err == nil {
		t.Error("SetRole accepted an unknown role")
	}
}

func TestRefreshManifestVersions(t *testing.T) {
	root := t.TempDir()
	ws, err := Create(root, CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	path := filepath.Join(root, "a.txt")
	if err := os.WriteFile(path, []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}

	m, _, err := ws.RefreshManifest()
	if err != nil {
		t.Fatalf("RefreshManifest: %v", err)
	}
	if len(m.Files) != 1 || m.Files[0].Version != 1 {
		t.Fatalf("first manifest = %+v, want one file at version 1", m.Files)
	}
	firstHash := m.Files[0].Hash

	// Record it, then refresh without changes: the version must not move.
	if err := ws.Store.PutFile(store.FileRow{
		Path: "a.txt", Size: 3, SHA256: firstHash, Version: 1,
	}); err != nil {
		t.Fatal(err)
	}
	m, _, err = ws.RefreshManifest()
	if err != nil {
		t.Fatal(err)
	}
	if m.Files[0].Version != 1 {
		t.Errorf("version after an unchanged refresh = %d, want 1", m.Files[0].Version)
	}

	// Change the content: the version advances.
	if err := os.WriteFile(path, []byte("two"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, _, err = ws.RefreshManifest()
	if err != nil {
		t.Fatal(err)
	}
	if m.Files[0].Version != 2 {
		t.Errorf("version after an edit = %d, want 2", m.Files[0].Version)
	}
	if m.Files[0].Hash == firstHash {
		t.Error("hash did not change after an edit")
	}
}

func TestRefreshManifestUsesStoredVersionAfterReseed(t *testing.T) {
	root := t.TempDir()
	ws, err := Create(root, CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	if err := os.WriteFile(filepath.Join(root, "b.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A joining peer receives the host's versions, which may be far ahead of
	// anything local; the next refresh must not reset them.
	if err := ws.Store.PutFile(store.FileRow{
		Path: "b.txt", Size: 1, SHA256: HashBytes([]byte("x")), Version: 12,
	}); err != nil {
		t.Fatal(err)
	}

	m, _, err := ws.RefreshManifest()
	if err != nil {
		t.Fatal(err)
	}
	if m.Files[0].Version != 12 {
		t.Errorf("version = %d, want the stored 12", m.Files[0].Version)
	}
}

func TestTotalTrackedBytes(t *testing.T) {
	ws, err := Create(t.TempDir(), CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()

	if err := ws.Store.UpsertFiles([]store.FileRow{
		{Path: "a", Size: 10, SHA256: "h", Version: 1},
		{Path: "b", Size: 32, SHA256: "h", Version: 1},
	}); err != nil {
		t.Fatal(err)
	}
	n, err := ws.TotalTrackedBytes()
	if err != nil {
		t.Fatal(err)
	}
	if n != 42 {
		t.Errorf("TotalTrackedBytes = %d, want 42", n)
	}
}

func TestCreatedAtPersists(t *testing.T) {
	root := t.TempDir()
	ws, err := Create(root, CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	created := ws.Created
	ws.Close()

	reopened, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Created.IsZero() {
		t.Fatal("Created is zero after reopen")
	}
	if d := reopened.Created.Sub(created); d > time.Second || d < -time.Second {
		t.Errorf("Created drifted by %v", d)
	}
}
