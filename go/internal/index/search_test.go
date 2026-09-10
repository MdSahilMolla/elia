package index

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixture builds a small workspace: searchable files, a node_modules dir that
// must be skipped, a binary file, and an oversized file.
func fixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"a.ts":              "const x = 1\nconst y = needle here\nconst z = 3\n",
		"sub/b.ts":          "nothing\nneedle again\ntrailing\n",
		"sub/c.js":          "no match in this file\n",
		"node_modules/d.ts": "needle in vendored code\n",
		".hidden/e.ts":      "needle in hidden file\n",
		"keep.txt":          "needle in txt\n",
		"context.ts":        "l0\nl1\nneedle middle\nl3\nl4\n",
	}
	for rel, body := range files {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte{'a', 0, 'b'}, 0o644); err != nil {
		t.Fatal(err)
	}
	big := make([]byte, maxSearchFileBytes+8)
	for i := range big {
		big[i] = 'x'
	}
	if err := os.WriteFile(filepath.Join(root, "big.ts"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func rels(matches []Match) []string {
	var out []string
	for _, m := range matches {
		out = append(out, m.Rel)
	}
	return out
}

func TestQueryBasic(t *testing.T) {
	res, err := Query("needle", fixture(t), "", 0)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, m := range res.Matches {
		got = append(got, m.Rel+":"+itoa(m.Line)+":"+m.Sep+":"+m.Text)
	}
	// a.ts line 2, sub/b.ts line 2, keep.txt line 1, context.ts line 3.
	// node_modules, dotfiles, binary, and oversized files are excluded.
	if len(res.Matches) != 4 {
		t.Fatalf("matches = %v", got)
	}
	if res.Matches[0].Rel != "a.ts" || res.Matches[0].Line != 2 || res.Matches[0].Text != "const y = needle here" {
		t.Fatalf("first match = %+v", res.Matches[0])
	}
	if res.SkippedLarge != 1 {
		t.Fatalf("skippedLarge = %d", res.SkippedLarge)
	}
	if res.SkippedBinary != 1 {
		t.Fatalf("skippedBinary = %d", res.SkippedBinary)
	}
	for _, m := range res.Matches {
		if strings.HasPrefix(m.Rel, "node_modules") || strings.HasPrefix(m.Rel, ".hidden") {
			t.Fatalf("skipped file matched: %+v", m)
		}
	}
}

func TestQueryGlob(t *testing.T) {
	res, err := Query("needle", fixture(t), "**/*.ts", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range res.Matches {
		if !strings.HasSuffix(m.Rel, ".ts") {
			t.Fatalf("glob leak: %+v", m)
		}
	}
	if len(res.Matches) != 3 { // a.ts, sub/b.ts, context.ts
		t.Fatalf("matches = %+v", res.Matches)
	}

	res, err = Query("needle", fixture(t), "**/*.{js,txt}", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Matches) != 1 { // only keep.txt (sub/c.js has no needle)
		t.Fatalf("matches = %+v", res.Matches)
	}
}

func TestQueryContextGrouping(t *testing.T) {
	res, err := Query("needle middle", fixture(t), "context.ts", 1)
	if err != nil {
		t.Fatal(err)
	}
	var rows []string
	for _, m := range res.Matches {
		rows = append(rows, m.Sep+itoa(m.Line)+":"+m.Text)
	}
	want := []string{"-2:l1", ":3:needle middle", "-4:l3"}
	if len(rows) != len(want) {
		t.Fatalf("rows = %v", rows)
	}
	for i := range want {
		if rows[i] != want[i] {
			t.Fatalf("rows = %v", rows)
		}
	}
}

func TestQueryErrors(t *testing.T) {
	root := fixture(t)
	if _, err := Query("(?=lookahead)", root, "", 0); err == nil || !strings.HasPrefix(err.Error(), "invalid regular expression:") {
		t.Fatalf("lookahead err = %v", err)
	}
	if _, err := Query("(", root, "", 0); err == nil || !strings.HasPrefix(err.Error(), "invalid regular expression:") {
		t.Fatalf("bad pattern err = %v", err)
	}
	if _, err := Query("", root, "", 0); err == nil {
		t.Fatalf("empty pattern should fail")
	}
	if _, err := Query("x", root, "", 99); err == nil {
		t.Fatalf("bad context should fail")
	}
	if _, err := Query("x", filepath.Join(root, "missing"), "", 0); err == nil {
		t.Fatalf("missing dir should fail")
	}
}

func TestQueryMatchCap(t *testing.T) {
	root := t.TempDir()
	var body strings.Builder
	for i := 0; i < 500; i++ {
		body.WriteString("needle line\n")
	}
	if err := os.WriteFile(filepath.Join(root, "many.ts"), []byte(body.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := Query("needle", root, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Truncated {
		t.Fatalf("expected truncation")
	}
	if len(res.Matches) != maxMatches {
		t.Fatalf("matches = %d", len(res.Matches))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
