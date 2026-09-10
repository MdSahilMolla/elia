// Package index implements the index.query service: a bounded, ripgrep-shaped
// recursive search over a workspace root.
//
// The contract mirrors searchWithJs in src/tools/grep.ts so results are
// interchangeable: the same skip lists, size caps, match caps, and context
// grouping. Known divergences are documented in go/README.md.
package index

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	maxPatternLength   = 10_000
	maxGlobLength      = 500
	maxSearchFileBytes = 5_000_000
	maxMatches         = 200
	maxContextLines    = 20
)

// collectTargets walks root once and returns the files that pass every
// static filter (symlinks, skip lists, dotfiles, glob), in lexical order.
func collectTargets(root, globPattern string) []fileTarget {
	var targets []fileTarget
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entry: skip, like the JS backend
		}
		if path == root {
			return nil
		}
		// Never follow symlinks: avoids escapes and cycles. (Divergence noted
		// in go/README.md.)
		if d.Type()&fs.ModeSymlink != 0 {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if _, skip := skipDirs[d.Name()]; skip {
				return filepath.SkipDir
			}
			if strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir // mirror Bun.Glob scan({dot:false})
			}
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
			return nil
		}
		slash := filepath.ToSlash(rel)
		base := d.Name()
		if strings.HasPrefix(base, ".") {
			return nil
		}
		if _, skip := skipRootFiles[base]; skip {
			return nil
		}
		for _, part := range strings.Split(slash, "/") {
			if _, skip := skipDirs[part]; skip {
				return nil
			}
		}
		if globPattern != "" && !matchGlob(globPattern, slash, base) {
			return nil
		}
		targets = append(targets, fileTarget{path: path, slash: slash})
		return nil
	})
	return targets
}

type fileTarget struct {
	path  string
	slash string
}

// searchParallel scans files with a bounded worker pool. Results land in
// walk-order slots so the merge is deterministic; size/binary counters are
// atomic. Files that vanish or error mid-scan are skipped like the JS backend.
func searchParallel(re *regexp.Regexp, targets []fileTarget, context int, c *counters) [][]Match {
	slots := make([][]Match, len(targets))
	if len(targets) == 0 {
		return slots
	}
	workers := min(runtime.NumCPU(), 8)
	if workers < 1 {
		workers = 1
	}
	var wg sync.WaitGroup
	next := make(chan int, len(targets))
	for i := range targets {
		next <- i
	}
	close(next)
	wg.Add(workers)
	for range workers {
		go func() {
			defer wg.Done()
			for i := range next {
				// Another file may already have filled the global cap; skip
				// remaining reads. The merge still caps deterministically.
				if c.total.Load() >= maxMatches {
					continue
				}
				t := targets[i]
				fi, err := os.Stat(t.path)
				if err != nil {
					continue
				}
				if fi.Size() > maxSearchFileBytes {
					c.large.Add(1)
					continue
				}
				data, err := os.ReadFile(t.path)
				if err != nil {
					continue
				}
				if bytes.IndexByte(data, 0) != -1 {
					c.binary.Add(1)
					continue
				}
				var matches []Match
				scanInto(re, t.slash, splitLines(data), context, &matches)
				c.total.Add(int64(len(matches)))
				slots[i] = matches
			}
		}()
	}
	wg.Wait()
	return slots
}

// Skip lists mirror SKIP_DIRS / SKIP_ROOT_FILES in src/tools/ignoreDirs.ts.
// Keep the two in lockstep.
var skipDirs = map[string]struct{}{
	"node_modules": {}, ".git": {}, "dist": {}, "build": {},
	"System Volume Information": {}, "$RECYCLE.BIN": {}, "$Recycle.Bin": {},
	"Config.Msi": {}, "Recovery": {}, "$WinREAgent": {}, "$SysReset": {},
	"PerfLogs": {},
}

var skipRootFiles = map[string]struct{}{
	"DumpStack.log.tmp": {}, "pagefile.sys": {}, "hiberfil.sys": {}, "swapfile.sys": {},
}

// Match is one output row. Sep is ":" for a match line, "-" for a context
// line, and "--" for a ripgrep-style group separator (Line is 0 there).
type Match struct {
	Rel  string `json:"rel"`
	Line int    `json:"line"`
	Sep  string `json:"sep"`
	Text string `json:"text"`
}

// QueryResult is the index.query result payload. It carries no locks so it
// can be returned by value; worker accounting lives in counters.
type QueryResult struct {
	Matches       []Match `json:"matches"`
	Truncated     bool    `json:"truncated"`
	SkippedLarge  int     `json:"skippedLarge"`
	SkippedBinary int     `json:"skippedBinary"`
}

// counters holds worker accounting. It is never marshaled or copied.
type counters struct {
	large  atomic.Int64
	binary atomic.Int64
	total  atomic.Int64
}

// Query searches root for pattern. Error messages mirror the TypeScript
// backend so an invalid request surfaces identically whichever tier runs.
func Query(pattern, root, globPattern string, context int) (QueryResult, error) {
	var out QueryResult
	if len(pattern) == 0 {
		return out, fmt.Errorf("pattern must be a non-empty string")
	}
	if len(pattern) > maxPatternLength {
		return out, fmt.Errorf("pattern exceeds %d characters", maxPatternLength)
	}
	if len(globPattern) > maxGlobLength {
		return out, fmt.Errorf("glob must be a non-empty string up to %d characters when provided", maxGlobLength)
	}
	if context < 0 || context > maxContextLines {
		return out, fmt.Errorf("context must be an integer from 0 to %d", maxContextLines)
	}
	// Go uses RE2: JS-isms like lookaheads fail here and surface as an invalid
	// pattern, exactly like the pure-JS backend would report a bad pattern.
	re, err := regexp.Compile(pattern)
	if err != nil {
		return out, fmt.Errorf("invalid regular expression: %s", err.Error())
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return out, fmt.Errorf("no such directory: %s", root)
	}

	targets := collectTargets(root, globPattern)
	var c counters
	slots := searchParallel(re, targets, context, &c)
	out.SkippedLarge = int(c.large.Load())
	out.SkippedBinary = int(c.binary.Load())

	// Merge in walk (lexical) order so output is byte-identical to a serial
	// scan; the match cap applies during the merge with the same silent stop.
	// Like the serial scan, hitting the cap exactly marks truncation — the
	// scanner cannot know whether more matches exist without reading on.
	for _, matches := range slots {
		for _, m := range matches {
			if len(out.Matches) >= maxMatches {
				out.Truncated = true
				return out, nil
			}
			out.Matches = append(out.Matches, m)
		}
	}
	out.Truncated = len(out.Matches) >= maxMatches
	return out, nil
}

// splitLines mirrors text.split('\n'); a trailing \r is stripped per line to
// match the ripgrep tier (the pure-JS tier keeps it — see go/README.md).
func splitLines(data []byte) []string {
	raw := strings.Split(string(data), "\n")
	for i, line := range raw {
		raw[i] = strings.TrimSuffix(line, "\r")
	}
	return raw
}

// scanInto ports the single-pass matcher from searchWithJs, including the
// context-group separators and the match-cap accounting (separators and
// context lines count toward the cap, and stopping is silent).
func scanInto(re *regexp.Regexp, slash string, lines []string, context int, matches *[]Match) {
	lastEmitted := -1
	for i, line := range lines {
		if !re.MatchString(line) {
			continue
		}
		if len(*matches) >= maxMatches {
			break
		}
		if context > 0 {
			from := max(i-context, 0)
			to := min(len(lines)-1, i+context)
			if lastEmitted >= 0 && from > lastEmitted+1 {
				*matches = append(*matches, Match{Rel: slash, Sep: "--"})
			}
			for j := max(from, lastEmitted+1); j <= to; j++ {
				sep := "-"
				if j == i {
					sep = ":"
				}
				*matches = append(*matches, Match{Rel: slash, Line: j + 1, Sep: sep, Text: lines[j]})
			}
			lastEmitted = to
		} else {
			*matches = append(*matches, Match{Rel: slash, Line: i + 1, Sep: ":", Text: line})
		}
	}
}
