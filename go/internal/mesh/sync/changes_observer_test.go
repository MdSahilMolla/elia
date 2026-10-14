package sync

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDiffCountsReportsChangedLines(t *testing.T) {
	patch := "" +
		"--- a/doc.md\n" +
		"+++ b/doc.md\n" +
		"@@ -1,3 +1,4 @@\n" +
		" keep one\n" +
		"-remove two\n" +
		" keep three\n" +
		"+add four\n"

	added, removed, ok := DiffCounts(patch)
	if !ok {
		t.Fatal("a patch with a hunk header must be recognised")
	}
	if added != 1 || removed != 1 {
		t.Fatalf("got +%d -%d, want +1 -1", added, removed)
	}
}

func TestDiffCountsRejectsSomethingThatIsNotAPatch(t *testing.T) {
	// A whole file arriving instead of a diff has no hunk header. Reporting zero
	// here would be a lie that reads as "nothing changed".
	if _, _, ok := DiffCounts("just some bytes\nno header here\n"); ok {
		t.Fatal("text without a hunk header must not be reported as a diff")
	}
}

func TestDiffCountsIgnoresTheHeaderLineItself(t *testing.T) {
	patch := "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n"
	added, removed, ok := DiffCounts(patch)
	if !ok {
		t.Fatal("want ok")
	}
	// The ---/+++ file headers begin with + and - too. Counting them would report
	// three added and three removed for a one-line change.
	if added != 1 || removed != 1 {
		t.Fatalf("got +%d -%d, want +1 -1: file headers were counted as content", added, removed)
	}
}

func TestObserveDiscardsWhenTheObserverIsNil(t *testing.T) {
	var o ChangeObserver
	// Must not panic: a nil observer is how "nobody is listening" is expressed.
	o.Observe(ChangeEvent{Path: "a", Op: OpUpdate})
}

func TestObserveDeliversToTheObserver(t *testing.T) {
	var got ChangeEvent
	o := ChangeObserver(func(ev ChangeEvent) { got = ev })
	o.Observe(ChangeEvent{Path: "src/a.ts", Op: OpCreate, OriginNode: OriginLocal})
	if got.Path != "src/a.ts" || got.Op != OpCreate || got.OriginNode != OriginLocal {
		t.Fatalf("got %+v", got)
	}
}

func TestChangeEventOmitsUnknownLineCounts(t *testing.T) {
	// A consumer distinguishing "no lines changed" from "not counted" relies on the
	// absent form surviving a round trip through JSON.
	b, err := json.Marshal(ChangeEvent{Path: "a", Op: OpDelete})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), `"added"`) || strings.Contains(string(b), `"removed"`) {
		t.Fatalf("counts must be omitted when unknown, got %s", b)
	}
	if !strings.Contains(string(b), `"op":"delete"`) {
		t.Fatalf("op must serialise, got %s", b)
	}
}

func TestChangeEventRoundTripsCountsAndBody(t *testing.T) {
	added, removed := 3, 1
	b, err := json.Marshal(ChangeEvent{
		Path:    "doc.md",
		Op:      OpUpdate,
		Added:   &added,
		Removed: &removed,
		Patch:   "@@ -1 +1 @@\n-a\n+b\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"added":3`, `"removed":1`, `"patch":`} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("missing %s in %s", want, b)
		}
	}
}
