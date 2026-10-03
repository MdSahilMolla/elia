package store

import "testing"

// A local change is recorded after it is sent, and the peer's acknowledgement can
// arrive in between. AdvanceFile must not overwrite the acknowledgement, because
// doing so leaves the file marked as an unconfirmed local change forever, which
// then conflicts every subsequent change to it.
func TestAdvanceFileDoesNotDemoteAnAcknowledgedRow(t *testing.T) {
	s := newTestStore(t)

	row := FileRow{Path: "a.txt", Size: 5, SHA256: "h1", Version: 2, LastWriter: "peer-1"}
	ok, err := s.ConfirmFile(row)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected the acknowledgement to be recorded")
	}

	// The local record for the same version arrives late. It must be refused.
	moved, err := s.AdvanceFile(FileRow{Path: "a.txt", Size: 5, SHA256: "h1", Version: 2, LastWriter: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if moved {
		t.Error("a same-version local record overwrote an acknowledgement")
	}

	got, err := s.GetFile("a.txt")
	if err != nil {
		t.Fatal(err)
	}
	if got.LastWriter != "peer-1" {
		t.Errorf("last_writer = %q, want peer-1; the file is stuck as unconfirmed", got.LastWriter)
	}
}

func TestAdvanceFileMovesForwardWhenTheVersionIsHigher(t *testing.T) {
	s := newTestStore(t)
	if err := s.PutFile(FileRow{Path: "a.txt", Size: 5, SHA256: "h1", Version: 2, LastWriter: "peer-1"}); err != nil {
		t.Fatal(err)
	}
	moved, err := s.AdvanceFile(FileRow{Path: "a.txt", Size: 6, SHA256: "h2", Version: 3, LastWriter: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if !moved {
		t.Error("a higher version should be recorded")
	}
	got, _ := s.GetFile("a.txt")
	if got.Version != 3 || got.LastWriter != "local" || got.SHA256 != "h2" {
		t.Errorf("unexpected row: %+v", got)
	}
}

// ConfirmFile accepts a same-version rewrite, which is how a pending local change
// is upgraded to agreed.
func TestConfirmFileUpgradesAPendingLocalRow(t *testing.T) {
	s := newTestStore(t)
	if err := s.PutFile(FileRow{Path: "a.txt", Size: 5, SHA256: "h1", Version: 3, LastWriter: "local"}); err != nil {
		t.Fatal(err)
	}
	ok, err := s.ConfirmFile(FileRow{Path: "a.txt", Size: 5, SHA256: "h1", Version: 3, LastWriter: "peer-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("a same-version confirmation should be accepted")
	}
	got, _ := s.GetFile("a.txt")
	if got.LastWriter != "peer-1" {
		t.Errorf("last_writer = %q, want peer-1", got.LastWriter)
	}
}

// A confirmation for a version the file has already moved past is stale and must
// not roll the row back.
func TestConfirmFileRefusesAStaleVersion(t *testing.T) {
	s := newTestStore(t)
	if err := s.PutFile(FileRow{Path: "a.txt", Size: 5, SHA256: "h2", Version: 7, LastWriter: "local"}); err != nil {
		t.Fatal(err)
	}
	ok, err := s.ConfirmFile(FileRow{Path: "a.txt", Size: 5, SHA256: "h1", Version: 3, LastWriter: "peer-1"})
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("a stale confirmation was accepted")
	}
	got, _ := s.GetFile("a.txt")
	if got.Version != 7 {
		t.Errorf("version = %d, want 7", got.Version)
	}
}
