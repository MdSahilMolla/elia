// Package diff describes a change as a patch rather than resending whole
// files.
//
// The engine is line-based for text and falls back to whole-file transfer for
// anything else. That split is not an optimisation, it is a correctness
// decision: a line patch against a binary file either fails to apply or, worse,
// half-applies. A whole-file transfer is always correct, so binary content uses
// it and text uses the cheaper form.
package diff

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Errors this package returns.
var (
	// ErrNotApplicable means the content is not something that can be patched as
	// text, and the caller should send the whole file instead.
	ErrNotApplicable = errors.New("diff: content is not patchable as text")
	// ErrApplyFailed means the patch did not match the local content. The
	// receiver must not guess: the honest response is to ask for the whole file.
	ErrApplyFailed = errors.New("diff: patch does not apply to local content")
	// ErrEmptyPatch means there was nothing to send.
	ErrEmptyPatch = errors.New("diff: patch is empty")
)

// MaxTextFileSize bounds the line-oriented path. Beyond this the memory needed
// to hold both versions and the diff exceeds what the change is worth, and the
// per-file limit already bounds the alternative.
const MaxTextFileSize = 4 << 20 // 4 MiB

// IsText reports whether content is worth patching as lines.
//
// The test is UTF-8 validity plus the absence of NUL bytes, which together
// exclude the formats that matter: images, archives, compiled objects and
// databases. A file that merely happens to decode is still a reasonable
// candidate, because a line patch that fails to apply falls back safely.
func IsText(content []byte) bool {
	if bytes.IndexByte(content, 0) >= 0 {
		return false
	}
	return utf8.Valid(content)
}

// Unified produces a unified diff turning before into after.
//
// It is exported in this form because the wire format carries the patch as an
// opaque text blob: the receiver applies it with the parser below rather than
// reimplementing hunk matching, which is where patch bugs live.
func Unified(before, after []byte, contextLines int) (string, error) {
	if !IsText(before) || !IsText(after) {
		return "", ErrNotApplicable
	}
	afterFile := parseText(after)
	out := unifiedFromLines(parseText(before).lines, afterFile.lines, contextLines, afterFile.noEOL)
	if out == "" {
		return "", ErrEmptyPatch
	}
	return out, nil
}

// DefaultContextLines is how much unchanged text surrounds each hunk. Three is
// the conventional value and is enough to anchor a hunk in most source files.
const DefaultContextLines = 3

// Apply applies a unified diff to content and returns the result.
//
// The whole patch is verified against the local text before any output is
// produced. A patch that does not fit returns ErrApplyFailed with the file
// untouched, because a partially applied patch would leave a file that is half
// old and half new and looks superficially fine.
func Apply(content []byte, patch string) ([]byte, error) {
	if !IsText(content) {
		return nil, ErrNotApplicable
	}
	src := parseText(content)
	result, noEOL, appended, err := applyUnified(src.lines, patch)
	if err != nil {
		return nil, err
	}
	switch {
	case noEOL:
		// The patch said so explicitly.
	case appended:
		// A line was added at the end, so the file now ends with a newline
		// unless the patch said otherwise.
	default:
		// The tail was untouched, so it keeps whatever it had.
		noEOL = src.noEOL
	}
	return textFile{lines: result, noEOL: noEOL}.render(), nil
}

// applyUnified parses and applies a unified diff.
//
// Hunk headers are advisory here: the context and removed lines in the body are
// what actually have to match. Positions come from walking the original list,
// which means a header with slightly wrong numbers still applies correctly,
// while a body that does not match the file is rejected.
// applyUnified returns the patched lines, whether the patch declared the final
// line to have no terminating newline, and whether it appended a line at the end.
//
// The two extra results are not decoration: together they let the caller decide
// the file's trailing-newline state, which a line-only representation cannot.
func applyUnified(lines []string, patch string) (out []string, noEOL bool, appended bool, err error) {
	var hunks []parseHunk
	cur := -1

	for _, raw := range strings.Split(patch, "\n") {
		if raw == "" {
			continue
		}
		if strings.TrimSpace(raw) == noEOLMarker {
			noEOL = true
			continue
		}
		if strings.HasPrefix(raw, "@@") {
			hunks = append(hunks, parseHunk{header: raw})
			cur = len(hunks) - 1
			continue
		}
		if cur < 0 {
			// File headers and anything before the first hunk are not part of
			// the diff.
			continue
		}
		switch raw[0] {
		case ' ', '+', '-':
			hunks[cur].body = append(hunks[cur].body, raw)
		default:
			// Not a diff line. Ignoring is safer than guessing.
		}
	}
	if len(hunks) == 0 {
		return nil, false, false, fmt.Errorf("%w: no hunks", ErrApplyFailed)
	}

	var result []string
	pos := 0
	for _, h := range hunks {
		// The hunk header says where the change goes. This matters more than it
		// looks: context lines repeat constantly in real files, so anchoring on
		// the body alone would happily apply a hunk to the wrong copy of a line
		// that appears a hundred times.
		anchor, ok := h.anchor()
		if ok {
			if anchor < pos {
				return nil, false, false, fmt.Errorf("%w: hunk at line %d overlaps the previous one", ErrApplyFailed, anchor+1)
			}
			if anchor > len(lines) {
				return nil, false, false, fmt.Errorf("%w: hunk starts at line %d but the file has %d",
					ErrApplyFailed, anchor+1, len(lines))
			}
			result = append(result, lines[pos:anchor]...)
			pos = anchor
		}

		added := 0
		_ = added
		for _, l := range h.body {
			text := l[1:]
			switch l[0] {
			case ' ':
				if pos >= len(lines) {
					return nil, false, false, mismatch(text, pos)
				}
				if lines[pos] != text {
					return nil, false, false, mismatch(text, pos)
				}
				result = append(result, text)
				pos++
			case '-':
				if pos >= len(lines) {
					return nil, false, false, mismatch(text, pos)
				}
				if lines[pos] != text {
					return nil, false, false, mismatch(text, pos)
				}
				pos++
			case '+':
				result = append(result, text)
				added++
			}
		}
		// Whether the hunk's last line is an addition decides the trailing
		// newline when the patch is silent about it. It has to be the last line
		// of the hunk: a line added in the middle leaves the file ending exactly
		// as it did before.
		if pos >= len(lines) && len(h.body) > 0 && h.body[len(h.body)-1][0] == '+' {
			appended = true
		}
	}
	result = append(result, lines[pos:]...)
	return result, noEOL, appended, nil
}

// parseHunk is one hunk: its header line and its prefixed body.
type parseHunk struct {
	header string
	body   []string
}

// anchor returns the 0-based index in the original file where this hunk applies.
//
// A zero old-count means pure insertion, and unified diff spells the position as
// one less than where the new lines land, so that case is corrected here rather
// than at every use site.
func (h parseHunk) anchor() (int, bool) {
	i := strings.Index(h.header, "@@ -")
	if i < 0 {
		return 0, false
	}
	rest := h.header[i+len("@@ -"):]
	comma := strings.Index(rest, ",")
	end := strings.Index(rest, " +")
	if comma < 0 || end < comma {
		return 0, false
	}
	start, err := parseInt(rest[:comma])
	if err != nil {
		return 0, false
	}
	count, err := parseInt(rest[comma+1 : end])
	if err != nil {
		return 0, false
	}
	if count == 0 {
		// Insertion: the header points at the line the block precedes.
		return start, true
	}
	return start - 1, true
}

func parseInt(s string) (int, error) {
	s = strings.TrimSpace(s)
	n := 0
	if s == "" {
		return 0, fmt.Errorf("empty number")
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, fmt.Errorf("not a number: %q", s)
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}

func mismatch(text string, pos int) error {
	return fmt.Errorf("%w: expected %q at line %d", ErrApplyFailed, text, pos+1)
}

// textFile is a parsed text file. The trailing-newline state is carried
// explicitly because a line diff cannot express it any other way: "a\nb" and
// "a\nb\n" have identical line lists, and a patch that loses the distinction
// silently rewrites every file it touches by one byte.
type textFile struct {
	lines []string
	// noEOL reports that the final line has no terminating newline.
	noEOL bool
}

func parseText(content []byte) textFile {
	if len(content) == 0 {
		return textFile{}
	}
	s := string(content)
	noEOL := !strings.HasSuffix(s, "\n")
	s = strings.TrimSuffix(s, "\n")
	return textFile{lines: strings.Split(s, "\n"), noEOL: noEOL}
}

// render turns the file back into bytes.
func (f textFile) render() []byte {
	if len(f.lines) == 0 {
		return nil
	}
	s := strings.Join(f.lines, "\n")
	if !f.noEOL {
		s += "\n"
	}
	return []byte(s)
}

// noEOLMarker is the standard annotation meaning "the line above has no
// terminating newline". Emitting and honouring it is what makes these patches
// interoperable with `diff -u` and `patch(1)`.
const noEOLMarker = "\\ No newline at end of file"

// unifiedFromLines renders a unified diff between two line sets.
//
// Hunks are built by finding the changed regions first and then widening them by
// contextLines on each side. Doing it in that order, rather than emitting as it
// walks, is what keeps the @@ line numbers correct: every operation knows the
// line it occupies on each side, so a hunk's start and count are read off rather
// than accumulated while output is being produced.
func unifiedFromLines(a, b []string, contextLines int, bNoEOL bool) string {
	if contextLines < 0 {
		contextLines = 0
	}
	ops := lineOps(a, b)

	// Attach 1-based line numbers to each operation on both sides.
	oldLine, newLine := 1, 1
	numbered := make([]numberedOp, len(ops))
	for i, op := range ops {
		numbered[i] = numberedOp{op: op, oldStart: oldLine, newStart: newLine}
		switch op.kind {
		case opEqual:
			oldLine++
			newLine++
		case opDelete:
			oldLine++
		case opInsert:
			newLine++
		}
	}

	// Group changes that are close enough to share context.
	type region struct{ start, end int }
	var regions []region
	for i := 0; i < len(numbered); {
		if numbered[i].op.kind == opEqual {
			i++
			continue
		}
		start := i
		end := i
		j := i
		for j < len(numbered) {
			if numbered[j].op.kind != opEqual {
				end = j
				j++
				continue
			}
			// Count the run of equal lines; if the next change is within twice
			// the context width, the two regions merge.
			run := 0
			for j+run < len(numbered) && numbered[j+run].op.kind == opEqual {
				run++
			}
			if j+run < len(numbered) && run <= 2*contextLines {
				j += run
				continue
			}
			break
		}
		regions = append(regions, region{start, end})
		i = j
	}
	if len(regions) == 0 {
		return ""
	}

	var out strings.Builder
	for _, r := range regions {
		from := r.start - contextLines
		if from < 0 {
			from = 0
		}
		to := r.end + contextLines
		if to >= len(numbered) {
			to = len(numbered) - 1
		}
		slice := numbered[from : to+1]

		oldCount, newCount := 0, 0
		for _, n := range slice {
			if n.op.kind == opEqual {
				oldCount++
				newCount++
			} else if n.op.kind == opDelete {
				oldCount++
			} else {
				newCount++
			}
		}
		oldStart, newStart := slice[0].oldStart, slice[0].newStart
		// A zero count means "no lines at this position", which unified diff
		// spells as start-1.
		if oldCount == 0 {
			oldStart--
		}
		if newCount == 0 {
			newStart--
		}
		fmt.Fprintf(&out, "@@ -%d,%d +%d,%d @@\n", oldStart, oldCount, newStart, newCount)
		for _, n := range slice {
			switch n.op.kind {
			case opEqual:
				out.WriteString(" " + n.op.text + "\n")
			case opDelete:
				out.WriteString("-" + n.op.text + "\n")
			case opInsert:
				out.WriteString("+" + n.op.text + "\n")
			}
		}
	}
	// The annotation belongs only when the final hunk actually reaches the last
	// line of the new file. Emitting it otherwise would strip the newline from a
	// tail the patch never touched.
	if len(regions) > 0 {
		last := regions[len(regions)-1]
		to := last.end + contextLines
		if to >= len(numbered) {
			to = len(numbered) - 1
		}
		from := last.start - contextLines
		if from < 0 {
			from = 0
		}
		if to >= from && to < len(numbered) && numbered[to].newStart == len(b) && bNoEOL {
			out.WriteString(noEOLMarker + "\n")
		}
	}
	return out.String()
}

type numberedOp struct {
	op       lineOp
	oldStart int
	newStart int
}

type opKind int

const (
	opEqual opKind = iota
	opDelete
	opInsert
)

type lineOp struct {
	kind opKind
	text string
}

// lineOps turns a line-level diff into a flat operation list. This is a simple
// longest-common-subsequence walk: files are small enough that a linear scan is
// not the bottleneck, and correctness is much easier to read here than in a
// tuned Myers implementation.
func lineOps(a, b []string) []lineOp {
	// Trim the common prefix and suffix first, which is where nearly all of the
	// speed comes from for a typical edit.
	start := 0
	for start < len(a) && start < len(b) && a[start] == b[start] {
		start++
	}
	endA, endB := len(a), len(b)
	for endA > start && endB > start && a[endA-1] == b[endB-1] {
		endA--
		endB--
	}

	ops := make([]lineOp, 0, start+(endA-start)+(endB-start))
	for _, l := range a[:start] {
		ops = append(ops, lineOp{opEqual, l})
	}

	midA, midB := a[start:endA], b[start:endB]
	ops = append(ops, lcsOps(midA, midB)...)

	for _, l := range a[endA:] {
		ops = append(ops, lineOp{opEqual, l})
	}
	return ops
}

// lcsOps diffs two equal-length-unknown slices with a dynamic-programming table.
// The inputs are only the changed middle of a file, so this stays small; a guard
// below falls back to a whole replacement if it does not.
func lcsOps(a, b []string) []lineOp {
	// Beyond this many changed lines the table is too expensive and a full
	// replacement is both cheaper and clearer.
	const maxCells = 4_000_000
	if (len(a)+1)*(len(b)+1) > maxCells {
		ops := make([]lineOp, 0, len(a)+len(b))
		for _, l := range a {
			ops = append(ops, lineOp{opDelete, l})
		}
		for _, l := range b {
			ops = append(ops, lineOp{opInsert, l})
		}
		return ops
	}

	n, m := len(a), len(b)
	table := make([][]int, n+1)
	for i := range table {
		table[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				table[i][j] = table[i+1][j+1] + 1
			} else if table[i+1][j] >= table[i][j+1] {
				table[i][j] = table[i+1][j]
			} else {
				table[i][j] = table[i][j+1]
			}
		}
	}

	var ops []lineOp
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			ops = append(ops, lineOp{opEqual, a[i]})
			i++
			j++
		case table[i+1][j] > table[i][j+1]:
			ops = append(ops, lineOp{opDelete, a[i]})
			i++
		default:
			// Insert, including on a tie. Both branches yield the same LCS
			// length, but preferring the insert lets the walk reach the next
			// match sooner. Preferring the delete here produces a correct but
			// needlessly large patch: replacing a middle line would delete every
			// line after it and re-insert them all.
			ops = append(ops, lineOp{opInsert, b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		ops = append(ops, lineOp{opDelete, a[i]})
	}
	for ; j < m; j++ {
		ops = append(ops, lineOp{opInsert, b[j]})
	}
	return ops
}
