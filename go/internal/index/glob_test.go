package index

import "testing"

func TestMatchGlob(t *testing.T) {
	cases := []struct {
		pattern, rel, base string
		want               bool
	}{
		{"*.ts", "a.ts", "a.ts", true},
		{"*.ts", "sub/a.ts", "a.ts", true}, // basename fallback
		{"*.ts", "a.js", "a.js", false},
		{"**/*.ts", "a.ts", "a.ts", true},
		{"**/*.ts", "sub/deep/a.ts", "a.ts", true},
		{"**/*.ts", "a.js", "a.js", false},
		{"**/*.{js,tsx}", "sub/a.tsx", "a.tsx", true},
		{"**/*.{js,tsx}", "a.js", "a.js", true},
		{"**/*.{js,tsx}", "a.ts", "a.ts", false},
		{"keep.txt", "sub/keep.txt", "keep.txt", true},
		{"keep.txt", "other.txt", "other.txt", false},
		{"sub/*.ts", "sub/a.ts", "a.ts", true},
		{"sub/*.ts", "a.ts", "a.ts", false},
	}
	for _, c := range cases {
		if got := matchGlob(c.pattern, c.rel, c.base); got != c.want {
			t.Errorf("matchGlob(%q, %q, %q) = %v, want %v", c.pattern, c.rel, c.base, got, c.want)
		}
	}
}
