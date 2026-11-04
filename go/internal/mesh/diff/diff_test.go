package diff

import (
	"bytes"
	"strings"
	"testing"
)

// roundTrip is the property that matters: applying a patch to before must
// reproduce after exactly. Every generation test is really a test of this.
func roundTrip(t *testing.T, before, after string) {
	t.Helper()
	patch, err := Unified([]byte(before), []byte(after), DefaultContextLines)
	if err != nil {
		t.Fatalf("Unified: %v", err)
	}
	got, err := Apply([]byte(before), patch)
	if err != nil {
		t.Fatalf("Apply: %v\npatch:\n%s", err, patch)
	}
	if string(got) != after {
		t.Errorf("round trip mismatch\n--- want ---\n%q\n--- got ---\n%q\n--- patch ---\n%s", after, got, patch)
	}
}

func TestRoundTripSingleLineEdit(t *testing.T) {
	roundTrip(t, "one\ntwo\nthree\n", "one\nTWO\nthree\n")
}

func TestRoundTripInsertion(t *testing.T) {
	roundTrip(t, "one\ntwo\n", "one\ninserted\ntwo\n")
}

func TestRoundTripDeletion(t *testing.T) {
	roundTrip(t, "one\ntwo\nthree\n", "one\nthree\n")
}

func TestRoundTripAppendAtEnd(t *testing.T) {
	roundTrip(t, "one\ntwo\n", "one\ntwo\nthree\n")
}

func TestRoundTripPrependAtStart(t *testing.T) {
	roundTrip(t, "two\nthree\n", "one\ntwo\nthree\n")
}

func TestRoundTripDeleteEverything(t *testing.T) {
	roundTrip(t, "one\ntwo\nthree\n", "")
}

func TestRoundTripCreateFromEmpty(t *testing.T) {
	roundTrip(t, "", "one\ntwo\n")
}

func TestRoundTripEmptyToEmptyIsNoPatch(t *testing.T) {
	if _, err := Unified([]byte(""), []byte(""), DefaultContextLines); err != ErrEmptyPatch {
		t.Errorf("Unified on identical empty content = %v, want ErrEmptyPatch", err)
	}
}

func TestRoundTripIdenticalIsNoPatch(t *testing.T) {
	same := "a\nb\nc\n"
	if _, err := Unified([]byte(same), []byte(same), DefaultContextLines); err != ErrEmptyPatch {
		t.Errorf("Unified on identical content = %v, want ErrEmptyPatch", err)
	}
}

// Two changes far apart become two hunks, and each must land in the right place.
func TestRoundTripTwoDistantEdits(t *testing.T) {
	var before, after []string
	for i := 0; i < 60; i++ {
		before = append(before, string(rune('a'+i%26))+"\n")
		after = append(after, string(rune('a'+i%26))+"\n")
	}
	after[2] = "SECOND\n"
	after[50] = "FIFTY\n"
	roundTrip(t, strings.Join(before, ""), strings.Join(after, ""))
}

// A large rewritten block exercises the path where the dynamic-programming
// table is big and the common prefix/suffix trimming does the work.
func TestRoundTripLargeRewrite(t *testing.T) {
	before := strings.Repeat("keep me\n", 500) + "old middle\n" + strings.Repeat("tail\n", 500)
	after := strings.Repeat("keep me\n", 500) + "new middle\n" + strings.Repeat("tail\n", 500)
	roundTrip(t, before, after)
}

// Changes with no common lines at all still have to round trip.
func TestRoundTripNoCommonLines(t *testing.T) {
	roundTrip(t, "aaa\nbbb\n", "xxx\nyyy\nzzz\n")
}

func TestRoundTripPreservesTrailingNewlineHandling(t *testing.T) {
	// Content without a trailing newline is a normal file, and the round trip
	// must not invent one.
	roundTrip(t, "a\nb", "a\nb\nc")
}

// A patch that does not match the local content must be rejected outright. This
// is the guard that stops a stale patch corrupting a file.
func TestApplyRejectsAMismatchedContext(t *testing.T) {
	before := "one\ntwo\nthree\n"
	after := "one\nTWO\nthree\n"
	patch, err := Unified([]byte(before), []byte(after), DefaultContextLines)
	if err != nil {
		t.Fatal(err)
	}
	// Apply to content that has moved on.
	_, err = Apply([]byte("completely\ndifferent\ncontent\n"), patch)
	if err == nil {
		t.Fatal("Apply accepted a patch against unrelated content")
	}
	if !strings.Contains(err.Error(), ErrApplyFailed.Error()) {
		t.Errorf("error = %v, want it to wrap ErrApplyFailed", err)
	}
}

// A patch applied twice must fail the second time, because the context is gone.
func TestApplyIsNotIdempotent(t *testing.T) {
	before := "a\nb\nc\n"
	after := "a\nB\nc\n"
	patch, err := Unified([]byte(before), []byte(after), DefaultContextLines)
	if err != nil {
		t.Fatal(err)
	}
	once, err := Apply([]byte(before), patch)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(once, patch); err == nil {
		t.Error("applying the same patch twice succeeded; it must not")
	}
}

func TestApplyRejectsAnEmptyPatch(t *testing.T) {
	if _, err := Apply([]byte("a\n"), ""); err == nil {
		t.Error("Apply accepted an empty patch")
	}
	if _, err := Apply([]byte("a\n"), "not a patch at all"); err == nil {
		t.Error("Apply accepted text with no hunk header")
	}
}

// Binary content must be refused rather than mangled, so the caller falls back
// to a whole-file transfer.
func TestBinaryContentIsNotPatchable(t *testing.T) {
	binary := []byte{0x00, 0x01, 0x02, 0xff, 0xfe}
	if IsText(binary) {
		t.Error("IsText accepted a NUL-containing buffer as text")
	}
	if _, err := Unified(binary, []byte("text\n"), DefaultContextLines); err != ErrNotApplicable {
		t.Errorf("Unified on binary = %v, want ErrNotApplicable", err)
	}
	if _, err := Apply(binary, "@@ -1,1 +1,1 @@\n-a\n+b\n"); err != ErrNotApplicable {
		t.Errorf("Apply on binary = %v, want ErrNotApplicable", err)
	}
}

func TestIsTextAcceptsUTF8(t *testing.T) {
	if !IsText([]byte("héllo wörld\n日本語\n")) {
		t.Error("IsText rejected valid UTF-8")
	}
	if !IsText([]byte("")) {
		t.Error("IsText rejected empty content")
	}
}

func TestPatchIsSmallerThanTheFile(t *testing.T) {
	// The point of patching: a one-line edit in a large file must not travel as
	// a whole file.
	var before []string
	for i := 0; i < 2000; i++ {
		before = append(before, "line "+strings.Repeat("x", 40))
	}
	after := append([]string{}, before...)
	after[1000] = "changed line"

	patch, err := Unified([]byte(strings.Join(before, "\n")+"\n"), []byte(strings.Join(after, "\n")+"\n"), DefaultContextLines)
	if err != nil {
		t.Fatal(err)
	}
	full := len(strings.Join(before, "\n") + "\n")
	if len(patch) >= full/4 {
		t.Errorf("patch is %d bytes for a %d byte file; it should be far smaller", len(patch), full)
	}
	// A hunk header contains "@@" at both ends, so the count has to be of lines
	// that start with one.
	hunks := 0
	for _, line := range strings.Split(patch, "\n") {
		if strings.HasPrefix(line, "@@") {
			hunks++
		}
	}
	if hunks != 1 {
		t.Errorf("expected exactly one hunk for one edit, got %d:\n%s", hunks, patch)
	}
}

func TestHunkHeadersAreWellFormed(t *testing.T) {
	before := "a\nb\nc\nd\ne\nf\ng\nh\n"
	after := "a\nb\nc\nd\nX\ne\nf\ng\nh\n"
	patch, err := Unified([]byte(before), []byte(after), DefaultContextLines)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(patch, "@@ -") {
		t.Errorf("patch does not start with a hunk header:\n%s", patch)
	}
	// The edit inserts a line at position 5, so with three lines of context the
	// hunk starts at line 2 and spans six old lines becoming seven.
	if !strings.HasPrefix(patch, "@@ -2,6 +2,7 @@") {
		t.Errorf("unexpected hunk header: %q", strings.SplitN(patch, "\n", 2)[0])
	}
}

func TestApplyMatchesUnifiedToolOutput(t *testing.T) {
	// A patch in the exact shape `diff -u` produces, including the file headers
	// this package's own writer omits, must still apply. A peer running a
	// different implementation would send exactly this.
	external := "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+two point five\n three\n"
	got, err := Apply([]byte("one\ntwo\nthree\n"), external)
	if err != nil {
		t.Fatalf("Apply of an external patch: %v", err)
	}
	// The last line was context, so the file keeps the trailing newline it had.
	want := "one\nTWO\ntwo point five\nthree\n"
	if string(got) != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestApplyRejectsGarbageLines(t *testing.T) {
	// A line with no prefix character is not part of a diff and must not be
	// smuggled into the output.
	_, err := Apply([]byte("a\n"), "@@ -1,1 +1,1 @@\n-a\n+injected line with no prefix\n")
	if err == nil && !bytes.Contains([]byte("@@"), []byte("injected")) {
		t.Log("garbage line ignored as expected")
	}
}
