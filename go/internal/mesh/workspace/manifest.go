package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/store"
)

// DefaultIgnoreRules are never synchronised. The first entry is the tool's own
// state directory: syncing it would ship one peer's database, keys and pairing
// codes to the other, which is both useless and a security problem. The second
// holds preserved conflict copies, which are this peer's business alone.
//
// The third is Elia's state directory, when this workspace is an Elia project.
// It holds the live workspace database in WAL mode plus the trust stores that
// decide what Elia is allowed to do, so syncing it would both corrupt the
// database and hand one peer authority over the other. Being host-side policy
// rather than project content, it is excluded here as well.
var DefaultIgnoreRules = []string{
	store.StateDirName,
	ConflictDirName,
	EliaStateDirName,
	".git",
	".DS_Store",
	"Thumbs.db",
	"node_modules",
}

// EliaStateDirName is Elia's per-project state directory.
const EliaStateDirName = ".elia"

// editorTempSuffixes cover the partial files editors leave behind. Syncing
// them would push noise between peers mid-save.
var editorTempSuffixes = []string{"~", ".swp", ".swx", ".swo", ".tmp", ".part", ".crdownload"}

// Manifest is a full inventory of a workspace.
type Manifest struct {
	WorkspaceID string      `json:"workspace_id"`
	Files       []FileEntry `json:"files"`
	GeneratedAt time.Time   `json:"generated_at"`
}

// FileEntry is one file in a manifest.
type FileEntry struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Hash    string `json:"hash"`
	Version int64  `json:"version"`
}

// TotalSize sums the manifest's file sizes.
func (m *Manifest) TotalSize() int64 {
	var n int64
	for _, f := range m.Files {
		n += f.Size
	}
	return n
}

// Has reports whether the manifest contains a path.
func (m *Manifest) Has(path string) bool {
	_, ok := m.Lookup(path)
	return ok
}

// Lookup finds one entry.
func (m *Manifest) Lookup(path string) (FileEntry, bool) {
	for _, f := range m.Files {
		if f.Path == path {
			return f, true
		}
	}
	return FileEntry{}, false
}

// Index builds a path-keyed view of the manifest, so repeated lookups during a
// sync do not rescan the slice per file.
func (m *Manifest) Index() map[string]FileEntry {
	out := make(map[string]FileEntry, len(m.Files))
	for _, f := range m.Files {
		out[f.Path] = f
	}
	return out
}

// Paths lists every path in the manifest.
func (m *Manifest) Paths() []string {
	out := make([]string, 0, len(m.Files))
	for _, f := range m.Files {
		out = append(out, f.Path)
	}
	return out
}

// IgnoreSet decides which workspace-relative paths are skipped.
type IgnoreSet struct {
	dirs   map[string]bool
	names  map[string]bool
	suffix []string
	// anchoredDirs are root-relative prefixes, matched only at the workspace root
	// rather than at any depth. They exist because some names are meaningful
	// deeper in a tree and only disposable at the top: a bare "workspace" rule
	// would match src/workspace/ and silently drop a project's real source.
	anchoredDirs []string
}

// NewIgnoreSet builds an ignore set from directory names, exact file names and
// suffix rules.
func NewIgnoreSet(dirs, names []string, suffixes []string) *IgnoreSet {
	s := &IgnoreSet{
		dirs:   make(map[string]bool, len(dirs)),
		names:  make(map[string]bool, len(names)),
		suffix: append([]string(nil), suffixes...),
	}
	for _, d := range dirs {
		s.dirs[d] = true
	}
	for _, n := range names {
		s.names[n] = true
	}
	return s
}

// EliaScratchDirName is Elia's visible scratch directory at a project root,
// declared in its .gitignore. Elia builds throwaway projects inside it, so it is
// machine-local output rather than something the two machines share.
const EliaScratchDirName = "workspace"

// DefaultAnchoredIgnoreRules are excluded only at the workspace root.
//
// The rule is anchored rather than a plain name because "workspace" is a real
// directory name inside a project: this repository keeps its own coordination
// code in src/workspace/. A name-only rule would match that too and quietly stop
// synchronising a project's source, which is a far worse failure than shipping
// a scratch directory between two machines the user already chose to connect.
var DefaultAnchoredIgnoreRules = []string{EliaScratchDirName}

// DefaultIgnoreSet returns the built-in policy.
func DefaultIgnoreSet() *IgnoreSet {
	s := NewIgnoreSet(DefaultIgnoreRules, nil, editorTempSuffixes)
	s.anchoredDirs = append([]string(nil), DefaultAnchoredIgnoreRules...)
	return s
}

// ShouldIgnore reports whether a workspace-relative path is excluded. A
// directory is matched by name at any depth, matching the intuition that
// "node_modules" means every node_modules.
func (s *IgnoreSet) ShouldIgnore(rel string) bool {
	if rel == "" {
		return true
	}
	// The anchored rules are checked first and against the whole path, so
	// "workspace/thing" is ignored while "src/workspace/thing" is not.
	for _, prefix := range s.anchoredDirs {
		if rel == prefix || strings.HasPrefix(rel, prefix+"/") {
			return true
		}
	}
	segs := strings.Split(rel, "/")
	for i, seg := range segs {
		if s.dirs[seg] {
			return true
		}
		if i == len(segs)-1 {
			if s.names[seg] {
				return true
			}
			lower := strings.ToLower(seg)
			for _, suf := range s.suffix {
				if strings.HasSuffix(lower, suf) {
					return true
				}
			}
		}
	}
	return false
}

// BuildManifest walks the workspace and returns its inventory. Symlinks are
// skipped and reported rather than followed, and anything failing validation is
// left out with a note instead of aborting the walk.
func BuildManifest(root, workspaceID string, versions map[string]int64, ignore *IgnoreSet) (*Manifest, []string, error) {
	if ignore == nil {
		ignore = DefaultIgnoreSet()
	}
	m := &Manifest{WorkspaceID: workspaceID, GeneratedAt: time.Now().UTC()}
	var skipped []string

	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, nil, fmt.Errorf("resolve workspace root: %w", err)
	}

	err = filepath.WalkDir(absRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// A file that vanished or became unreadable mid-walk is not fatal;
			// note it and keep going.
			skipped = append(skipped, fmt.Sprintf("%s: %v", path, walkErr))
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}

		rel, err := filepath.Rel(absRoot, path)
		if err != nil {
			skipped = append(skipped, fmt.Sprintf("%s: %v", path, err))
			return nil
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)

		if ignore.ShouldIgnore(rel) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}

		if d.Type()&os.ModeSymlink != 0 {
			// Following a symlink would let workspace content point anywhere on
			// the host, so symlinks are never synchronised.
			skipped = append(skipped, rel+": symlink, not synchronised")
			return nil
		}

		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			skipped = append(skipped, rel+": not a regular file")
			return nil
		}

		info, err := d.Info()
		if err != nil {
			skipped = append(skipped, fmt.Sprintf("%s: %v", rel, err))
			return nil
		}
		if info.Size() > security.MaxFileSize {
			skipped = append(skipped, fmt.Sprintf("%s: %s (%d bytes)", rel, "exceeds size limit", info.Size()))
			return nil
		}

		// The path came from our own walk, but validate anyway: the manifest
		// is the first thing a remote peer acts on.
		if _, err := security.ValidateFileForSync(root, rel, info.Size(), false); err != nil {
			skipped = append(skipped, fmt.Sprintf("%s: %v", rel, err))
			return nil
		}

		hash, err := HashFile(path)
		if err != nil {
			skipped = append(skipped, fmt.Sprintf("%s: %v", rel, err))
			return nil
		}

		version := int64(1)
		if v, ok := versions[rel]; ok && v > 0 {
			version = v
		}
		m.Files = append(m.Files, FileEntry{
			Path:    rel,
			Size:    info.Size(),
			Hash:    hash,
			Version: version,
		})
		return nil
	})
	if err != nil {
		return nil, nil, fmt.Errorf("walk workspace: %w", err)
	}

	// A stable order makes manifests comparable and tests deterministic.
	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].Path < m.Files[j].Path })
	return m, skipped, nil
}

// HashFile streams a file through SHA-256 rather than reading it whole, so a
// large file does not have to fit in memory.
func HashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("hash %s: %w", filepath.Base(path), err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// HashBytes returns the hex SHA-256 of an in-memory buffer.
func HashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ApplyPolicy decides what a caller is allowed to do with a diff.
//
// The default is the safe one. A file the user edited locally and that the
// remote also changed is not overwritten, because replacing it is the one
// action in this program that destroys work the user can see.
type ApplyPolicy struct {
	// OverwriteDivergent permits replacing locally-edited files with the
	// remote version. It is opt-in per command, never a default.
	OverwriteDivergent bool
	// PreserveDivergent copies the remote version aside under a conflict name
	// instead of applying it, and records the divergence. When false, a
	// divergent file is left completely alone: no write, no copy, no record.
	PreserveDivergent bool
}

// DefaultApplyPolicy preserves divergent files and takes no destructive action.
func DefaultApplyPolicy() ApplyPolicy {
	return ApplyPolicy{PreserveDivergent: true}
}

// DiffResult classifies every path by what each side has.
type DiffResult struct {
	// Missing: the remote has it, this peer has no such file. Safe to fetch.
	Missing []string
	// Stale: both have it, the local copy is unchanged since the last agreed
	// version, and the remote has moved on. Safe to replace.
	Stale []string
	// Divergent: both have it, both changed since the last agreed version.
	// This is the case that used to destroy work.
	Divergent []string
	// LocalOnly: this peer has it, the remote does not. Left alone.
	LocalOnly []string
}

// Needs reports whether a path is one the remote would need to bring this peer
// up to date, counting divergent files only when the policy allows replacing
// them.
func (d DiffResult) Needs(policy ApplyPolicy) []string {
	out := append([]string{}, d.Missing...)
	out = append(out, d.Stale...)
	if policy.OverwriteDivergent {
		out = append(out, d.Divergent...)
	}
	sort.Strings(out)
	return out
}

// Empty reports whether both sides already agree and no local extras exist.
func (d DiffResult) Empty() bool {
	return len(d.Missing) == 0 && len(d.Stale) == 0 &&
		len(d.Divergent) == 0 && len(d.LocalOnly) == 0
}

// Diff computes what a peer needs in order to match the remote manifest.
//
// base is the last state both sides agreed on, as recorded in the store. It is
// what makes this a three-way comparison: a hash mismatch only means "the
// remote moved" when the local copy is untouched since the agreement. When the
// local copy has also moved, the file is divergent and must not be replaced.
//
// A nil or incomplete base is treated as "nothing is known to be agreed", which
// makes every mismatch divergent. That is the conservative direction: on a
// first join into a folder that already has files, the remote's copies are
// preserved for review instead of overwriting what is there.
func Diff(remote *Manifest, local, base map[string]FileEntry) DiffResult {
	var d DiffResult
	seen := make(map[string]bool, len(remote.Files))

	for _, rf := range remote.Files {
		seen[rf.Path] = true
		lf, ok := local[rf.Path]
		if !ok {
			d.Missing = append(d.Missing, rf.Path)
			continue
		}
		if lf.Hash == rf.Hash {
			// Same content. Versions may still differ, which is a bookkeeping
			// detail rather than a conflict.
			continue
		}
		b, known := base[rf.Path]
		if known && b.Hash == lf.Hash {
			// The local file is exactly as we last agreed, so the difference is
			// purely the remote's update.
			d.Stale = append(d.Stale, rf.Path)
			continue
		}
		d.Divergent = append(d.Divergent, rf.Path)
	}
	for path := range local {
		if !seen[path] {
			d.LocalOnly = append(d.LocalOnly, path)
		}
	}
	sort.Strings(d.Missing)
	sort.Strings(d.Stale)
	sort.Strings(d.Divergent)
	sort.Strings(d.LocalOnly)
	return d
}

// LocalEntries describes the current on-disk state of the workspace.
func LocalEntries(root string, ignore *IgnoreSet) (map[string]FileEntry, error) {
	if ignore == nil {
		ignore = DefaultIgnoreSet()
	}
	out := make(map[string]FileEntry)

	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	err = filepath.WalkDir(absRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		rel, err := filepath.Rel(absRoot, path)
		if err != nil || rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if ignore.ShouldIgnore(rel) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() || d.Type()&os.ModeSymlink != 0 || !d.Type().IsRegular() {
			return nil
		}
		hash, err := HashFile(path)
		if err != nil {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		out[rel] = FileEntry{Path: rel, Size: info.Size(), Hash: hash, Version: 1}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ErrNoSuchFile means a requested path is not present in the workspace.
var ErrNoSuchFile = errors.New("no such file in workspace")
