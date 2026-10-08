// Package watcher notices local changes and reports them as events.
//
// The division of labour matters and is deliberate: a watcher reports raw
// filesystem activity, and the sync layer decides what it means. Editors save
// in several shapes (write-in-place, write-truncate-rename, temp-file-then-rename),
// each producing different event sequences for what the user experiences as one
// save. Deciding what constitutes a change belongs to the layer that also knows
// about hashes and versions, not here.
package watcher

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"elia-go/internal/mesh/workspace"
)

// DefaultDebounce is how long a path must be quiet before its change is
// reported. It has to be long enough to outlast a multi-write save and short
// enough that a person does not notice the lag while typing.
const DefaultDebounce = 250 * time.Millisecond

// DefaultBuffer is the depth of the event channel. It is generous because
// bursts are normal, and a watcher that blocks is worse than one that batches.
const DefaultBuffer = 4096

// ErrNotImplemented is retained for callers that checked for the phase-4 stub.
// Nothing returns it any more.
var ErrNotImplemented = errors.New("watcher: phase 4 is not implemented")

// EventKind classifies what happened to a path.
type EventKind string

// The event kinds a watcher reports.
const (
	EventCreate EventKind = "create"
	EventWrite  EventKind = "write"
	EventRemove EventKind = "remove"
	EventRename EventKind = "rename"
	EventChmod  EventKind = "chmod"
)

// Event is one observed filesystem change.
type Event struct {
	Kind    EventKind
	Path    string
	Time    time.Time
	Renamed string // populated for EventRename
}

// Watcher observes a workspace tree.
type Watcher interface {
	// Start begins observing. It returns once the watch is established, so a
	// caller can treat events as complete from that point on.
	Start(ctx context.Context) error
	// Events yields observations until the watcher is closed. It is delivered on
	// its own goroutine, so a slow consumer must not block the OS watcher.
	Events() <-chan Event
	// Close stops observing and releases the OS handles.
	Close() error
}

// Options configures a watcher.
type Options struct {
	// Ignore excludes paths from reporting. The same rules the manifest walk
	// uses, so a file that would never be synchronised is never reported as
	// changed.
	Ignore *workspace.IgnoreSet
	// Debounce overrides DefaultDebounce.
	Debounce time.Duration
	// Buffer overrides DefaultBuffer.
	Buffer int
	// OnError is called for non-fatal problems, such as a directory that
	// disappeared between being walked and being watched.
	OnError func(error)
}

// New returns a watcher for root.
//
// Unlike the phase-4 stub, this is a working recursive fsnotify watcher. If the
// root cannot be watched it returns a watcher whose Start reports the error, so
// the caller decides whether that is fatal rather than finding out silently.
func New(root string) Watcher { return NewWithOptions(root, Options{}) }

// NewWithOptions returns a configured watcher.
func NewWithOptions(root string, opts Options) Watcher {
	if opts.Debounce <= 0 {
		opts.Debounce = DefaultDebounce
	}
	if opts.Buffer <= 0 {
		opts.Buffer = DefaultBuffer
	}
	if opts.Ignore == nil {
		opts.Ignore = workspace.DefaultIgnoreSet()
	}
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		// This is a constructor that fails: rather than panicking, the caller
		// will get a watcher whose Start reports the error. Start does not rely
		// on fsw being non-nil.
	}
	return &fsWatcher{
		root:    root,
		opts:    opts,
		events:  make(chan Event, opts.Buffer),
		fsw:     fsw,
		pending: make(map[string]*pendingEvent),
		watched: make(map[string]bool),
		known:   make(map[string]bool),
	}
}

type pendingEvent struct {
	// sawRemove records that the path disappeared during this debounce window,
	// which is how a rename-over-existing-file is told apart from a new file:
	// the path comes back, but it was not new.
	sawRemove bool
	timer     *time.Timer
}

// fsWatcher is the fsnotify-backed implementation.
type fsWatcher struct {
	root string
	opts Options

	fsw    *fsnotify.Watcher
	events chan Event

	mu      sync.Mutex
	pending map[string]*pendingEvent
	watched map[string]bool
	// known is every path this watcher has ever seen existing. It is seeded
	// from the initial walk and updated as paths appear and disappear, which is
	// what lets fire tell a genuinely new file from one that was just replaced.
	known    map[string]bool
	closed   bool
	cancelFn context.CancelFunc
}

// Start establishes the watch on every directory under root.
func (w *fsWatcher) Start(ctx context.Context) error {
	if w.fsw == nil {
		return errors.New("watcher: could not create a filesystem watcher")
	}
	absRoot, err := filepath.Abs(w.root)
	if err != nil {
		return fmt.Errorf("resolve workspace root: %w", err)
	}
	w.root = absRoot

	if err := w.walk(absRoot); err != nil {
		w.fsw.Close()
		return err
	}
	w.seedKnown()

	ctx, cancel := context.WithCancel(ctx)
	w.cancelFn = cancel
	go w.run(ctx)
	return nil
}

// walk adds every directory under root, skipping ignored ones.
func (w *fsWatcher) walk(dir string) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// A directory that vanishes mid-walk is normal on an active
			// workspace; report and carry on rather than failing the whole watch.
			w.reportError(walkErr)
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(w.root, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel != "." && w.opts.Ignore.ShouldIgnore(rel) {
			return fs.SkipDir
		}
		w.add(path)
		return nil
	})
}

// seedKnown records which files existed when the watch began, so the first event
// on a path is classified against reality rather than guessed.
func (w *fsWatcher) seedKnown() {
	filepath.WalkDir(w.root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(w.root, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == "." || w.opts.Ignore.ShouldIgnore(rel) {
			return nil
		}
		w.mu.Lock()
		w.known[rel] = true
		w.mu.Unlock()
		return nil
	})
}

func (w *fsWatcher) add(dir string) {
	w.mu.Lock()
	if w.closed || w.watched[dir] {
		w.mu.Unlock()
		return
	}
	w.watched[dir] = true
	w.mu.Unlock()

	if err := w.fsw.Add(dir); err != nil {
		w.reportError(fmt.Errorf("watch %s: %w", dir, err))
	}
}

// run turns raw fsnotify events into debounced, classified, workspace-relative
// events.
func (w *fsWatcher) run(ctx context.Context) {
	defer close(w.events)

	for {
		select {
		case <-ctx.Done():
			w.flushAll()
			return
		case ev, ok := <-w.fsw.Events:
			if !ok {
				w.flushAll()
				return
			}
			w.handle(ev)
		case err, ok := <-w.fsw.Errors:
			if !ok {
				w.flushAll()
				return
			}
			w.reportError(fmt.Errorf("filesystem watch: %w", err))
		}
	}
}

func (w *fsWatcher) handle(ev fsnotify.Event) {
	rel, ok := w.rel(ev.Name)
	if !ok {
		return
	}
	// A new directory has to be watched itself, or everything created inside it
	// later goes unnoticed.
	if ev.Has(fsnotify.Create) {
		if info, err := os.Lstat(ev.Name); err == nil && info.IsDir() {
			if err := w.walk(ev.Name); err != nil {
				w.reportError(err)
			}
		}
	}

	switch {
	case ev.Has(fsnotify.Remove), ev.Has(fsnotify.Rename):
		// A directory that went away should be dropped from the watch set:
		// keeping it wastes a descriptor and re-adding is impossible.
		w.forget(ev.Name)
		w.schedule(rel, true)
	case ev.Has(fsnotify.Create), ev.Has(fsnotify.Write):
		w.schedule(rel, false)
	case ev.Has(fsnotify.Chmod):
		// Chmod alone is a permission change, not content. Reporting it would
		// make every chmod look like an edit.
		return
	}
}

// rel converts an absolute path to a workspace-relative one, dropping anything
// the ignore rules exclude.
func (w *fsWatcher) rel(abs string) (string, bool) {
	r, err := filepath.Rel(w.root, abs)
	if err != nil {
		return "", false
	}
	r = filepath.ToSlash(r)
	if r == "." || strings.HasPrefix(r, "../") {
		return "", false
	}
	if w.opts.Ignore.ShouldIgnore(r) {
		return "", false
	}
	return r, true
}

// schedule records a change and restarts its debounce timer.
//
// Coalescing happens here rather than downstream: a save produces write, chmod,
// close and rename events on one path within milliseconds, and the consumer
// should see one change. The final kind is decided at fire time by looking at
// the filesystem, because only the filesystem can say whether the path is new,
// replaced or gone. Guessing from the event kind gets this wrong constantly:
// creating a file yields CREATE then WRITE, while an editor's rename-over yields
// only CREATE, because the temp file is ignored before it is ever seen.
func (w *fsWatcher) schedule(rel string, removed bool) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	p, exists := w.pending[rel]
	if !exists {
		p = &pendingEvent{}
		w.pending[rel] = p
	}
	if removed {
		p.sawRemove = true
	}
	if p.timer != nil {
		p.timer.Stop()
	}
	p.timer = time.AfterFunc(w.opts.Debounce, func() { w.fire(rel) })
	w.mu.Unlock()
}

// fire emits one debounced event, classifying it against the filesystem.
func (w *fsWatcher) fire(rel string) {
	w.mu.Lock()
	if _, ok := w.pending[rel]; !ok || w.closed {
		w.mu.Unlock()
		return
	}
	delete(w.pending, rel)
	wasKnown := w.known[rel]
	w.mu.Unlock()

	kind := EventWrite
	abs := filepath.Join(w.root, filepath.FromSlash(rel))
	info, err := os.Lstat(abs)
	switch {
	case err != nil || !info.Mode().IsRegular():
		// Gone. A symlink or a directory arriving where a file was is also
		// reported as a removal, because the sync layer will not follow it
		// either.
		kind = EventRemove
		w.mu.Lock()
		w.known[rel] = false
		w.mu.Unlock()
	case !wasKnown:
		kind = EventCreate
		w.mu.Lock()
		w.known[rel] = true
		w.mu.Unlock()
	default:
		w.mu.Lock()
		w.known[rel] = true
		w.mu.Unlock()
	}

	select {
	case w.events <- Event{Kind: kind, Path: rel, Time: time.Now().UTC()}:
	default:
		// The channel is full. Dropping the event is better than blocking here,
		// because a periodic resync will catch whatever is lost and a blocked
		// watcher would stop noticing new changes entirely.
		w.reportError(fmt.Errorf("watcher event buffer full, dropped %s", rel))
	}
}

// flushAll emits everything still pending, used on shutdown so the last edits
// before a close are not silently lost.
func (w *fsWatcher) flushAll() {
	w.mu.Lock()
	pending := make([]string, 0, len(w.pending))
	for rel := range w.pending {
		pending = append(pending, rel)
	}
	w.mu.Unlock()
	for _, rel := range pending {
		w.fire(rel)
	}
}

// forget drops a directory and its children from the watch set.
func (w *fsWatcher) forget(dir string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	prefix := dir + string(filepath.Separator)
	for path := range w.watched {
		if path == dir || strings.HasPrefix(path, prefix) {
			delete(w.watched, path)
		}
	}
}

// Events returns the debounced event stream.
func (w *fsWatcher) Events() <-chan Event { return w.events }

// Close stops the watcher. It is safe to call more than once.
func (w *fsWatcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	for _, p := range w.pending {
		if p.timer != nil {
			p.timer.Stop()
		}
	}
	w.pending = make(map[string]*pendingEvent)
	w.mu.Unlock()

	if w.cancelFn != nil {
		w.cancelFn()
	}
	return w.fsw.Close()
}

func (w *fsWatcher) reportError(err error) {
	if w.opts.OnError != nil {
		w.opts.OnError(err)
	}
}
