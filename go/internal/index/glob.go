// Minimal glob support for the index.query glob filter, stdlib-only.
//
// It covers the shapes the grep tool actually receives ("*.ts", "**/*.tsx",
// "**/*.{js,tsx}", bare filenames) and mirrors the TypeScript matching rule:
// the pattern is tried against the slash-separated relative path and against
// the basename.
package index

import (
	"path"
	"strings"
)

// matchGlob reports whether pattern selects the file at slashRel (basename base).
func matchGlob(pattern, slashRel, base string) bool {
	for _, alt := range splitBraces(pattern) {
		if matchSingle(alt, slashRel) || matchSingle(alt, base) {
			return true
		}
	}
	return false
}

func matchSingle(pattern, name string) bool {
	if strings.Contains(pattern, "**/") {
		// "**/" matches zero or more leading segments: try the remainder
		// against the full path and every trailing subpath.
		suffix := pattern[strings.Index(pattern, "**/")+3:]
		parts := strings.Split(name, "/")
		for i := range parts {
			if ok, _ := path.Match(suffix, strings.Join(parts[i:], "/")); ok {
				return true
			}
		}
		return false
	}
	ok, _ := path.Match(pattern, name)
	return ok
}

// splitBraces expands one level of top-level {a,b,c} alternation.
func splitBraces(pattern string) []string {
	start := strings.Index(pattern, "{")
	if start == -1 {
		return []string{pattern}
	}
	depth := 0
	for i := start; i < len(pattern); i++ {
		switch pattern[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				prefix, suffix := pattern[:start], pattern[i+1:]
				var out []string
				for _, alt := range splitTopLevel(pattern[start+1 : i]) {
					out = append(out, prefix+alt+suffix)
				}
				return out
			}
		}
	}
	return []string{pattern}
}

// splitTopLevel splits s on commas that are not nested in braces.
func splitTopLevel(s string) []string {
	var parts []string
	depth := 0
	cur := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '{':
			depth++
		case '}':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, s[cur:i])
				cur = i + 1
			}
		}
	}
	return append(parts, s[cur:])
}
