package store

import (
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestOpenCreatesStateDir(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	if want := filepath.Join(root, StateDirName, DBFileName); s.Path() != want {
		t.Errorf("Path = %q, want %q", s.Path(), want)
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	root := t.TempDir()

	first, err := Open(root)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	if err := first.SetMeta("workspace_id", "ws_abc123"); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}
	first.Close()

	second, err := Open(root)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer second.Close()

	var n int
	if err := second.DB().QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil {
		t.Fatalf("count migrations: %v", err)
	}
	if n != len(migrations) {
		t.Errorf("applied migrations = %d, want %d", n, len(migrations))
	}

	got, err := second.GetMeta("workspace_id")
	if err != nil {
		t.Fatalf("GetMeta after reopen: %v", err)
	}
	if got != "ws_abc123" {
		t.Errorf("workspace_id = %q, want ws_abc123", got)
	}
}

func TestMetaRoundTrip(t *testing.T) {
	s := newTestStore(t)

	if err := s.SetMeta("join_host", "10.0.0.4"); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}
	got, err := s.GetMeta("join_host")
	if err != nil {
		t.Fatalf("GetMeta: %v", err)
	}
	if got != "10.0.0.4" {
		t.Errorf("got %q, want 10.0.0.4", got)
	}

	// Overwrite.
	if err := s.SetMeta("join_host", "127.0.0.1"); err != nil {
		t.Fatalf("SetMeta overwrite: %v", err)
	}
	if got, _ := s.GetMeta("join_host"); got != "127.0.0.1" {
		t.Errorf("after overwrite got %q, want 127.0.0.1", got)
	}

	if _, err := s.GetMeta("absent"); err == nil {
		t.Error("GetMeta(absent) returned nil error, want ErrNotFound")
	}
}

func TestPutAndGetFile(t *testing.T) {
	s := newTestStore(t)

	row := FileRow{Path: "src/app.py", Size: 4820, SHA256: "abc", Version: 3, LastWriter: "peer_b", MTimeNS: 42}
	if err := s.PutFile(row); err != nil {
		t.Fatalf("PutFile: %v", err)
	}

	got, err := s.GetFile("src/app.py")
	if err != nil {
		t.Fatalf("GetFile: %v", err)
	}
	if got != row {
		t.Errorf("GetFile = %+v, want %+v", got, row)
	}

	if _, err := s.GetFile("nope.txt"); err == nil {
		t.Error("GetFile(missing) returned nil error, want ErrNotFound")
	}
}

func TestUpsertFilesIsAtomic(t *testing.T) {
	s := newTestStore(t)

	rows := []FileRow{
		{Path: "a.txt", Size: 1, SHA256: "h1", Version: 1},
		{Path: "b/c.txt", Size: 2, SHA256: "h2", Version: 1},
	}
	if err := s.UpsertFiles(rows); err != nil {
		t.Fatalf("UpsertFiles: %v", err)
	}

	all, err := s.AllFiles()
	if err != nil {
		t.Fatalf("AllFiles: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("len(AllFiles) = %d, want 2", len(all))
	}
	// Ordered by path.
	if all[0].Path != "a.txt" || all[1].Path != "b/c.txt" {
		t.Errorf("unexpected order: %q, %q", all[0].Path, all[1].Path)
	}

	if err := s.DeleteFile("a.txt"); err != nil {
		t.Fatalf("DeleteFile: %v", err)
	}
	if n, _ := s.CountFiles(); n != 1 {
		t.Errorf("CountFiles after delete = %d, want 1", n)
	}
}

func TestPeerByCert(t *testing.T) {
	s := newTestStore(t)

	p := PeerRow{
		PeerID:      "peer_b",
		Role:        RoleMember,
		CertSHA256:  "deadbeef",
		DisplayName: "B",
		JoinedAt:    timeUnix(1000),
		LastSeen:    timeUnix(2000),
	}
	if err := s.AddPeer(p); err != nil {
		t.Fatalf("AddPeer: %v", err)
	}

	got, err := s.PeerByCert("deadbeef")
	if err != nil {
		t.Fatalf("PeerByCert: %v", err)
	}
	if got.PeerID != "peer_b" || got.Role != RoleMember {
		t.Errorf("PeerByCert = %+v", got)
	}

	if _, err := s.PeerByCert("nosuchcert"); err == nil {
		t.Error("PeerByCert(unknown) returned nil error, want ErrNotFound")
	}
}
