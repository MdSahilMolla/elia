// Package engine keeps a workspace in step with the peers attached to it.
//
// A session finishes its initial sync and then stays open. From that point this
// engine is what happens: it watches the filesystem and sends local edits, it
// applies or refuses incoming ones, it answers liveness probes, and it
// periodically reconciles with peers that have gone quiet.
//
// The design constraints worth stating up front, because they explain the shape
// of the code:
//
//   - One read goroutine per peer, many writers. A link's frames must arrive in
//     order, so exactly one goroutine may read from a connection. Writes are
//     serialised inside the connection, so any number of goroutines may send.
//   - Applying a remote change writes to disk, which the watcher observes. Every
//     such write is recorded so the resulting event can be recognised as an echo
//     and not sent straight back. Without that a one-line edit would ping-pong
//     between two peers forever.
//   - Nothing is applied on trust. A change is checked against the local version
//     first, written, and only then confirmed by hash, and a file whose hash does
//     not come out right is not left on disk.
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"elia-go/internal/mesh/diff"
	"elia-go/internal/mesh/security"
	"elia-go/internal/mesh/store"
	wsync "elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/versioning"
	"elia-go/internal/mesh/watcher"
	"elia-go/internal/mesh/workspace"
)

// Mode says whether this peer is hosting or joining, which decides how peers
// are attached and what role the workspace plays.
type Mode string

// The two roles.
const (
	ModeHost   Mode = "host"
	ModeMember Mode = "member"
)

// Defaults for the engine's timers. They are deliberately short: a sync session
// that feels alive should notice a dead peer in seconds, not minutes.
const (
	DefaultPingInterval   = 20 * time.Second
	DefaultResyncInterval = 60 * time.Second
	// ReadTimeout is how long a read may block before the peer is assumed gone.
	// It must exceed the ping interval by enough to tolerate a slow round trip
	// and scheduling delay, or an idle but healthy peer gets disconnected.
	DefaultReadTimeout = DefaultPingInterval * 3
	// SuppressionTTL bounds how long a written hash is remembered so its echo can
	// be recognised. An entry that outlives this cannot be trusted anyway: by then
	// the write it described is not the newest thing that happened to the file.
	DefaultSuppressionTTL = 30 * time.Second
	// DefaultCacheBytes caps the memory spent remembering the last agreed content
	// of files, which is what makes a patch possible instead of a full resend.
	DefaultCacheBytes = 64 << 20
	// DefaultMaxCachedFile is the largest single file worth remembering. Beyond
	// this a full transfer is cheaper than holding the file twice.
	DefaultMaxCachedFile = 4 << 20
)

// Config configures an engine.
type Config struct {
	Workspace *workspace.Workspace
	Mode      Mode
	// Events receives progress and conflict notifications. Nil discards them.
	Events wsync.EventSink
	// Changes receives a structured event for every file change, whether local or
	// received, applied or refused. Nil discards them. This is what a consumer
	// such as Elia uses to build a file activity feed without parsing the prose
	// in Events.
	Changes wsync.ChangeObserver
	// Controls receives opaque frames relayed from a peer by its supervisor.
	// Nil discards them, which is what an ordinary file-sync consumer wants: a
	// peer running Elia must not force every other consumer to understand a
	// protocol it has no use for.
	Controls wsync.ControlObserver
	// Watcher overrides the default filesystem watcher, for tests.
	Watcher watcher.Watcher

	PingInterval   time.Duration
	ResyncInterval time.Duration
	ReadTimeout    time.Duration
	// CacheBytes and MaxCachedFile bound the patch-baseline cache.
	CacheBytes    int64
	MaxCachedFile int64
	// Now is injectable so heartbeat and suppression timing can be tested.
	Now func() time.Time
}

// Engine synchronises one workspace with every attached peer.
type Engine struct {
	ws       *workspace.Workspace
	tracker  *versioning.Tracker
	events   wsync.EventSink
	changes  wsync.ChangeObserver
	controls wsync.ControlObserver
	watch    watcher.Watcher
	cfg      Config
	now      func() time.Time

	mu         sync.Mutex
	peers      map[string]*link
	suppressed map[string]suppression

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	closeOnce sync.Once
	closed    chan struct{}
}

// suppression remembers a write this engine made on a remote peer's behalf, so
// the watcher event it provokes can be dropped instead of echoed.
type suppression struct {
	hash string
	at   time.Time
}

func (e *Engine) clock() time.Time {
	if e.now != nil {
		return e.now()
	}
	return time.Now()
}

func (e *Engine) pingInterval() time.Duration {
	if e.cfg.PingInterval > 0 {
		return e.cfg.PingInterval
	}
	return DefaultPingInterval
}

func (e *Engine) resyncInterval() time.Duration {
	if e.cfg.ResyncInterval > 0 {
		return e.cfg.ResyncInterval
	}
	return DefaultResyncInterval
}

func (e *Engine) readTimeout() time.Duration {
	if e.cfg.ReadTimeout > 0 {
		return e.cfg.ReadTimeout
	}
	return DefaultReadTimeout
}

func (e *Engine) cacheBytes() int64 {
	if e.cfg.CacheBytes > 0 {
		return e.cfg.CacheBytes
	}
	return DefaultCacheBytes
}

func (e *Engine) maxCachedFile() int64 {
	if e.cfg.MaxCachedFile > 0 {
		return e.cfg.MaxCachedFile
	}
	return DefaultMaxCachedFile
}

// New builds an engine for a workspace.
func New(cfg Config) (*Engine, error) {
	if cfg.Workspace == nil {
		return nil, errors.New("engine: workspace is required")
	}
	e := &Engine{
		ws:         cfg.Workspace,
		tracker:    versioning.NewTracker(cfg.Workspace),
		events:     cfg.Events,
		changes:    cfg.Changes,
		controls:   cfg.Controls,
		watch:      cfg.Watcher,
		cfg:        cfg,
		now:        cfg.Now,
		peers:      map[string]*link{},
		suppressed: map[string]suppression{},
		closed:     make(chan struct{}),
	}
	if e.watch == nil {
		e.watch = watcher.NewWithOptions(cfg.Workspace.Root, watcher.Options{
			Ignore:  cfg.Workspace.Ignore,
			OnError: func(err error) { e.events.Emit(wsync.EventError, "watch: %v", err) },
		})
	}
	return e, nil
}

// Run starts the background loops and returns once they are running. It does not
// block; Close stops everything.
func (e *Engine) Run(ctx context.Context) error {
	e.ctx, e.cancel = context.WithCancel(ctx)

	if err := e.watch.Start(e.ctx); err != nil {
		return fmt.Errorf("start watcher: %w", err)
	}

	e.wg.Add(3)
	go e.watchLoop()
	go e.heartbeatLoop()
	go e.resyncLoop()
	return nil
}

// Close stops the engine, detaches every peer, and releases the watcher. It is
// safe to call more than once.
func (e *Engine) Close() error {
	var err error
	e.closeOnce.Do(func() {
		if e.cancel != nil {
			e.cancel()
		}
		close(e.closed)

		e.mu.Lock()
		peers := make([]*link, 0, len(e.peers))
		for _, l := range e.peers {
			peers = append(peers, l)
		}
		e.peers = map[string]*link{}
		e.mu.Unlock()

		for _, l := range peers {
			l.close()
		}
		e.wg.Wait()
		err = e.watch.Close()
	})
	return err
}

// link is one attached peer.
type link struct {
	peerID string
	conn   *wsync.Conn
	engine *Engine

	// cache holds the content this peer and the remote last agreed on, which is
	// the only thing a patch can be generated against. It is per link because
	// two peers joined at different times have different notions of the base.
	cache *contentCache
	// baseline maps a path to the version the remote was last told about, so a
	// delete can report the version it applies to and a resync can tell which
	// files the remote is missing.
	// sendMu serialises full-file transfers on this link. A transfer occupies
	// several frames and the receiver tracks only one in-flight body, so two
	// overlapping transfers would interleave and be mistaken for a corrupt file.
	// The watcher and the resync loop both send, so the lock is what keeps them
	// from stepping on each other.
	sendMu   sync.Mutex
	mu       sync.Mutex
	informed map[string]int64
	// lastSeen is the last time a frame arrived, used to spot a peer that has
	// gone quiet without closing the socket.
	lastSeen time.Time

	// done is closed when this link stops: the socket failed, the peer said
	// goodbye, or the engine is shutting down. A session layer blocks on it to
	// keep a connection's lifetime the same as the peer's presence.
	done     chan struct{}
	doneOnce sync.Once
}

// finish marks the link as finished. It is safe to call more than once, because a
// failed read, an explicit detach, and shutdown can all race for the same link.
func (l *link) finish() {
	l.doneOnce.Do(func() { close(l.done) })
}

func (l *link) close() {
	l.finish()
	_ = l.conn.Send(wsync.TypeLeave, wsync.Leave{PeerID: l.peerID, Reason: "shutting down"})
	l.conn.Close()
}

func (l *link) noteInformed(path string, version int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.informed == nil {
		l.informed = map[string]int64{}
	}
	l.informed[path] = version
}

func (l *link) informedVersion(path string) (int64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	v, ok := l.informed[path]
	return v, ok
}

// Attach begins synchronising with a connected peer.
//
// The baseline cache is seeded from disk, on the assumption that the initial sync
// has just completed and both sides therefore agree with what is on disk. That is
// what lets the first local edit leave as a patch rather than a whole file.
func (e *Engine) Attach(peerID string, conn *wsync.Conn) error {
	if peerID == "" {
		return errors.New("engine: peer id is required")
	}
	l := &link{
		peerID:   peerID,
		conn:     conn,
		engine:   e,
		cache:    newContentCache(e.cacheBytes(), e.maxCachedFile()),
		informed: map[string]int64{},
		lastSeen: e.clock(),
		done:     make(chan struct{}),
	}
	e.seedCache(l)

	e.mu.Lock()
	if _, dup := e.peers[peerID]; dup {
		e.mu.Unlock()
		return fmt.Errorf("engine: peer %s is already attached", peerID)
	}
	e.peers[peerID] = l
	e.mu.Unlock()

	e.events.Emit(wsync.EventConnected, "peer %s attached", peerID)

	e.wg.Add(1)
	go e.receiveLoop(l)
	return nil
}

// seedCache records the current content of every file worth remembering.
func (e *Engine) seedCache(l *link) {
	entries, err := workspace.LocalEntries(e.ws.Root, e.ws.Ignore)
	if err != nil {
		e.events.Emit(wsync.EventError, "read local files: %v", err)
		return
	}
	for path := range entries {
		abs, err := security.SecureJoin(e.ws.Root, path)
		if err != nil {
			continue
		}
		content, err := readFile(abs)
		if err != nil {
			continue
		}
		l.cache.Put(path, content)
		row, err := e.ws.Store.GetFile(path)
		version := int64(0)
		if err == nil {
			version = row.Version
		}
		l.noteInformed(path, version)
	}
}

// Detach removes a peer and closes its connection.
func (e *Engine) Detach(peerID string) {
	e.mu.Lock()
	l, ok := e.peers[peerID]
	if ok {
		delete(e.peers, peerID)
	}
	e.mu.Unlock()
	if ok {
		l.close()
	}
}

// WaitPeer blocks until the link to peerID ends, or until ctx is done. It reports
// the context error, so a caller can tell "the peer left" from "we are stopping".
//
// The session layer needs this because a connection's lifetime and the peer's
// presence have to be the same thing: returning as soon as the initial
// synchronisation finishes would drop every change made after it.
func (e *Engine) WaitPeer(ctx context.Context, peerID string) error {
	e.mu.Lock()
	l, ok := e.peers[peerID]
	e.mu.Unlock()
	if !ok {
		return fmt.Errorf("engine: no peer %q", peerID)
	}
	select {
	case <-l.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-e.closed:
		return nil
	}
}

func (e *Engine) peerCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.peers)
}

func (e *Engine) snapshotPeers() []*link {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]*link, 0, len(e.peers))
	for _, l := range e.peers {
		out = append(out, l)
	}
	return out
}

// receiveLoop is the single reader for a peer's connection.
func (e *Engine) receiveLoop(l *link) {
	defer e.wg.Done()
	defer func() {
		e.mu.Lock()
		if e.peers[l.peerID] == l {
			delete(e.peers, l.peerID)
		}
		e.mu.Unlock()
		l.finish()
		l.conn.Close()
		e.events.Emit(wsync.EventDisconnected, "peer %s disconnected", l.peerID)
	}()

	// A full file announced by PATCH arrives as FILE_TRANSFER frames followed by
	// FILE_COMPLETE, so the loop has to know it is in the middle of a body.
	var inflight *incomingFile

	for {
		select {
		case <-e.ctx.Done():
			return
		case <-e.closed:
			return
		default:
		}

		if err := l.conn.SetReadDeadline(e.clock().Add(e.readTimeout())); err != nil {
			return
		}
		typ, payload, err := l.conn.Receive()
		if err != nil {
			if isExpectedShutdown(err, e.ctx) {
				return
			}
			e.events.Emit(wsync.EventError, "peer %s: %v", l.peerID, err)
			return
		}
		l.mu.Lock()
		l.lastSeen = e.clock()
		l.mu.Unlock()

		if err := e.handle(l, typ, payload, &inflight); err != nil {
			if errors.Is(err, errDetach) {
				return
			}
			e.events.Emit(wsync.EventError, "peer %s: %v", l.peerID, err)
		}
	}
}

func isExpectedShutdown(err error, ctx context.Context) bool {
	return ctx.Err() != nil || errors.Is(err, wsync.ErrClosed) || errors.Is(err, wsync.ErrProtocol)
}

func (e *Engine) handle(l *link, typ wsync.MessageType, payload []byte, inflight **incomingFile) error {
	switch typ {
	case wsync.TypePatch:
		var batch wsync.Changes
		if err := json.Unmarshal(payload, &batch); err != nil {
			return fmt.Errorf("decode PATCH: %w", err)
		}
		// Announce full transfers before handling the rest, so the frames that
		// follow are collected against the right destination.
		e.receiveBatch(l, &batch, inflight)
		return nil

	case wsync.TypeFileTransfer:
		if *inflight == nil {
			return fmt.Errorf("%w: file transfer with nothing in flight", wsync.ErrProtocol)
		}
		var chunk wsync.FileTransfer
		if err := json.Unmarshal(payload, &chunk); err != nil {
			return fmt.Errorf("decode FILE_TRANSFER: %w", err)
		}
		return (*inflight).add(chunk)

	case wsync.TypeFileComplete:
		if *inflight == nil {
			return fmt.Errorf("%w: file complete with nothing in flight", wsync.ErrProtocol)
		}
		var done wsync.FileComplete
		if err := json.Unmarshal(payload, &done); err != nil {
			return fmt.Errorf("decode FILE_COMPLETE: %w", err)
		}
		f := *inflight
		*inflight = nil
		return e.finishIncoming(l, f, done)

	case wsync.TypePing:
		var ping wsync.Ping
		if err := json.Unmarshal(payload, &ping); err != nil {
			return fmt.Errorf("decode PING: %w", err)
		}
		return l.conn.Send(wsync.TypePong, wsync.Pong{ID: ping.ID, Sent: ping.Sent})

	case wsync.TypePong:
		// Answering a ping is the only proof the peer is really there. Nothing to
		// do beyond noting the time the read loop already recorded.
		return nil

	case wsync.TypeConflict:
		var report wsync.ConflictReport
		if err := json.Unmarshal(payload, &report); err != nil {
			return fmt.Errorf("decode CONFLICT: %w", err)
		}
		e.handleConflictReport(l, report)
		return nil

	case wsync.TypeLeave:
		var bye wsync.Leave
		_ = json.Unmarshal(payload, &bye)
		return errDetach

	case wsync.TypeControl:
		var frame wsync.Control
		if err := json.Unmarshal(payload, &frame); err != nil {
			return fmt.Errorf("decode CONTROL: %w", err)
		}
		if len(frame.Payload) == 0 {
			// A frame with no body cannot be relayed onward, so there is nothing
			// useful to hand the supervisor. Treating it as a protocol error
			// keeps a buggy peer from filling the observer with empties.
			return fmt.Errorf("%w: CONTROL frame with no payload", wsync.ErrProtocol)
		}
		if len(frame.Payload) > wsync.MaxControlBytes {
			return fmt.Errorf("%w: CONTROL payload of %d bytes exceeds the %d limit", wsync.ErrProtocol, len(frame.Payload), wsync.MaxControlBytes)
		}
		e.controls.Observe(frame)
		return nil

	case wsync.TypeError:
		var msg wsync.ErrorMsg
		if err := json.Unmarshal(payload, &msg); err != nil {
			return fmt.Errorf("decode ERROR: %w", err)
		}
		e.events.Emit(wsync.EventError, "peer %s reported %s: %s", l.peerID, msg.Code, msg.Message)
		return nil

	case wsync.TypeSyncDone:
		var done wsync.SyncDone
		if err := json.Unmarshal(payload, &done); err != nil {
			return fmt.Errorf("decode SYNC_DONE: %w", err)
		}
		e.events.Emit(wsync.EventInfo, "peer %s sent %d changes (%d conflicted)", l.peerID, done.Files, done.Divergent)
		return nil

	case wsync.TypeAck:
		var ack wsync.Ack
		if err := json.Unmarshal(payload, &ack); err != nil {
			return fmt.Errorf("decode ACK: %w", err)
		}
		// The peer has our change, so the file is agreed rather than a local edit
		// waiting for confirmation. Until this arrives the file stays marked as a
		// pending local change, which is what stops a peer's change from being
		// applied over work the other side has not seen.
		exists, hash, err := e.ws.LocalExists(ack.Path)
		if err != nil {
			return nil
		}
		if !exists {
			// The acked change may have been a delete, which leaves a tombstone
			// with no file behind it. There is nothing to hash in that case, so
			// the tombstone is confirmed as it stands.
			e.confirmGoneAck(l, ack)
			return nil
		}
		size, err := fileSize(e.ws, ack.Path)
		if err != nil {
			return nil
		}
		if _, err := e.ws.ConfirmFile(ack.Path, size, hash, ack.Version, l.peerID); err != nil {
			e.events.Emit(wsync.EventError, "record ack for %s: %v", ack.Path, err)
		}
		return nil

	default:
		// Receive already refused unknown types, so this is unreachable; handling
		// it keeps the loop total if the vocabulary grows.
		return fmt.Errorf("%w: unexpected message %s", wsync.ErrProtocol, typ)
	}
}

// errDetach asks the receive loop to end after a clean goodbye.
var errDetach = errors.New("peer left")

// incomingFile is a file being received, either to be applied or to be preserved
// because it turned out to conflict.
type incomingFile struct {
	change   wsync.FileChange
	data     []byte
	preserve bool
}

func (f *incomingFile) add(chunk wsync.FileTransfer) error {
	if chunk.Path != f.change.Path {
		return fmt.Errorf("%w: transfer for %q while %q is in flight", wsync.ErrProtocol, chunk.Path, f.change.Path)
	}
	// The size cap is enforced while collecting rather than after, so a peer
	// cannot exhaust memory by claiming a small file and sending more of it.
	if int64(len(f.data))+int64(len(chunk.Data)) > security.MaxFileSize {
		return fmt.Errorf("%w: %s exceeds the file size limit", security.ErrTooLarge, chunk.Path)
	}
	f.data = append(f.data, chunk.Data...)
	return nil
}

// receiveBatch checks each incoming change and applies or preserves it.
func (e *Engine) receiveBatch(l *link, batch *wsync.Changes, inflight **incomingFile) {
	applied, conflicted := 0, 0
	for i := range batch.Changes {
		change := batch.Changes[i]
		switch change.Op {
		case wsync.OpDelete:
			if e.applyDelete(l, change) {
				applied++
			} else {
				conflicted++
			}
		case wsync.OpCreate, wsync.OpUpdate:
			if change.Full {
				// The content is on its way; decide now where it will land.
				d, err := e.tracker.Check(versioning.Change{
					Op:          string(change.Op),
					Path:        change.Path,
					BaseVersion: change.BaseVersion,
					Version:     change.Version,
					NewHash:     change.NewHash,
					OldHash:     change.OldHash,
					Size:        change.Size,
				})
				if err != nil {
					e.events.Emit(wsync.EventError, "check %s: %v", change.Path, err)
					conflicted++
					continue
				}
				if d.Apply {
					*inflight = &incomingFile{change: change}
					applied++
					continue
				}
				// A conflict still has to preserve what the remote sent, so the
				// transfer continues into a conflict copy.
				//
				// ResendFull is deliberately false. This refusal is about versions,
				// not about the patch failing to apply, so the remote's file is
				// already correct and asking for it again would produce a resend
				// loop: the peer resends, is refused for the same reason, and so on.
				conflicted++
				// Only the report is sent here. The store row is written once the
				// body has been preserved, in finishIncoming, so one divergence
				// produces one row rather than two for the same event.
				e.sendConflict(l, change, conflictKind(d.Conflict), "", false)
				*inflight = &incomingFile{change: change, preserve: true}
				continue
			}
			// A patch is checked against the local version before it is applied,
			// exactly as a full transfer is. Applying first and looking at the hash
			// afterwards would let a stale-base patch through whenever the content
			// happened to line up, which is precisely the case where the two sides
			// have diverged in a way that must be reported.
			d, err := e.tracker.Check(versioning.Change{
				Op:          string(change.Op),
				Path:        change.Path,
				BaseVersion: change.BaseVersion,
				Version:     change.Version,
				NewHash:     change.NewHash,
				OldHash:     change.OldHash,
				Size:        change.Size,
			})
			if err != nil {
				e.events.Emit(wsync.EventError, "check %s: %v", change.Path, err)
				conflicted++
				continue
			}
			if !d.Apply {
				// Asking for the whole file here is not about forcing the change in.
				// It is the only way to obtain the incoming content, so there is
				// something to preserve for the user instead of a bare refusal.
				conflicted++
				e.reportConflict(l, d.Conflict, change, true)
				continue
			}
			ok, isConflict := e.applyPatch(l, change)
			if isConflict {
				conflicted++
			} else if ok {
				applied++
			}
		default:
			e.events.Emit(wsync.EventError, "peer %s sent unknown op %q", l.peerID, change.Op)
		}
	}
	if applied > 0 {
		e.events.Emit(wsync.EventPatch, "applied %d change(s) from %s", applied, l.peerID)
	}
	_ = conflicted
}

// finishIncoming verifies a fully received file and either applies it or keeps it
// as the preserved copy of a conflict.
func (e *Engine) finishIncoming(l *link, f *incomingFile, done wsync.FileComplete) error {
	if done.Path != f.change.Path {
		return fmt.Errorf("%w: FILE_COMPLETE for %q while %q is in flight", wsync.ErrProtocol, done.Path, f.change.Path)
	}
	if int64(len(f.data)) != done.Size {
		return fmt.Errorf("%w: %s is %d bytes, expected %d", wsync.ErrProtocol, done.Path, len(f.data), done.Size)
	}
	// The hash is checked before anything is written, so a body that was
	// corrupted in transit never reaches the workspace at all.
	hash, err := hashBytes(f.data)
	if err != nil {
		return err
	}
	if done.Hash != "" && hash != done.Hash {
		return fmt.Errorf("%w: %s hashed %s, expected %s", wsync.ErrProtocol, done.Path, hash, done.Hash)
	}

	if f.preserve {
		kept, err := e.ws.PreserveConflict(f.change.Path, f.data, l.peerID, e.clock())
		if err != nil {
			return fmt.Errorf("preserve %s: %w", f.change.Path, err)
		}
		localVersion, _, err := e.tracker.Base(f.change.Path)
		if err != nil {
			localVersion = 0
		}
		_, localHash, err := e.ws.LocalExists(f.change.Path)
		if err != nil {
			localHash = ""
		}
		report, err := e.ws.Store.RecordConflict(store.ConflictRow{
			Path:          f.change.Path,
			Kind:          store.ConflictBothEdited,
			BaseVersion:   f.change.BaseVersion,
			LocalVersion:  localVersion,
			RemoteVersion: f.change.Version,
			LocalHash:     localHash,
			RemoteHash:    hash,
			PeerID:        l.peerID,
			KeptPath:      kept.Path,
			DetectedAt:    e.clock().UTC(),
		})
		if err != nil {
			return err
		}
		e.events.Emit(wsync.EventConflict, "conflict #%d on %s: kept their version at %s", report, f.change.Path, kept.Path)
		e.ObserveConflict(l, f.change, store.ConflictBothEdited, "kept their version", kept.Path)
		return nil
	}

	// Enforce the workspace cap before writing, using the incoming size rather
	// than the size on disk so a replacement is not counted twice.
	if err := e.ws.CheckReplace("", int64(len(f.data))); err != nil {
		e.sendConflict(l, f.change, store.ConflictBothEdited, err.Error(), false)
		return err
	}
	if err := e.writeFile(f.change.Path, f.data); err != nil {
		return err
	}
	if err := e.tracker.Advance(f.change.Path, int64(len(f.data)), hash, f.change.Version, l.peerID); err != nil {
		return err
	}
	l.cache.Put(f.change.Path, f.data)
	l.noteInformed(f.change.Path, f.change.Version)
	e.suppress(f.change.Path, hash)
	e.events.Emit(wsync.EventPatch, "%s updated from %s", f.change.Path, l.peerID)
	// A whole-file transfer has no incoming patch, so the body and the line counts
	// stay absent: this side never held a diff for it.
	e.ObserveApplied(l, f.change, "", int64(len(f.data)), hash)
	// Confirming the version is what tells the sender its change is agreed, and
	// that it may be built on.
	return l.conn.Send(wsync.TypeAck, wsync.Ack{Path: f.change.Path, Version: f.change.Version})
}

// applyPatch applies a unified diff to the local file.
func (e *Engine) applyPatch(l *link, change wsync.FileChange) (applied bool, conflicted bool) {
	abs, joinErr := security.SecureJoin(e.ws.Root, change.Path)
	var local []byte
	var readErr error
	if joinErr != nil {
		// A path whose directory does not exist has no local content to patch.
		// That is not a malformed path, it is a new subdirectory, and the answer
		// is to ask for the whole file rather than to reject the change.
		if !errors.Is(joinErr, fs.ErrNotExist) {
			e.events.Emit(wsync.EventError, "reject %s: %v", change.Path, joinErr)
			return false, true
		}
		readErr = joinErr
	} else {
		local, readErr = readFile(abs)
	}
	if readErr != nil {
		// No local content to patch. A create with an empty base is the normal
		// case here and is a conflict only if the path was previously agreed.
		version, _, _ := e.tracker.Base(change.Path)
		if version == 0 {
			e.sendConflict(l, change, store.ConflictBothEdited, "no local content to patch", true)
			return false, false
		}
		e.sendConflict(l, change, store.ConflictDeleteEdit, "local file is missing", false)
		return false, true
	}

	patch := string(change.Patch)
	result, err := diff.Apply(local, patch)
	if err != nil {
		// A patch that will not apply is not a conflict about versions: the
		// content moved in a way the version numbers do not show. Asking for the
		// whole file lets the change land when the two sides agree, and produces
		// a preserved copy when they do not.
		e.sendConflict(l, change, store.ConflictRemoteNewer, err.Error(), true)
		return false, false
	}
	hash, err := hashBytes(result)
	if err != nil {
		e.events.Emit(wsync.EventError, "hash patched %s: %v", change.Path, err)
		return false, true
	}
	if change.NewHash != "" && hash != change.NewHash {
		e.sendConflict(l, change, store.ConflictRemoteNewer, "patched content did not match the announced hash", true)
		return false, false
	}
	if err := e.ws.CheckReplace(abs, int64(len(result))); err != nil {
		e.sendConflict(l, change, store.ConflictBothEdited, err.Error(), false)
		return false, true
	}
	if err := e.writeFile(change.Path, result); err != nil {
		e.events.Emit(wsync.EventError, "write %s: %v", change.Path, err)
		return false, true
	}
	if err := e.tracker.Advance(change.Path, int64(len(result)), hash, change.Version, l.peerID); err != nil {
		e.events.Emit(wsync.EventError, "record %s: %v", change.Path, err)
		return false, true
	}
	l.cache.Put(change.Path, result)
	l.noteInformed(change.Path, change.Version)
	e.suppress(change.Path, hash)
	e.events.Emit(wsync.EventPatch, "%s patched from %s", change.Path, l.peerID)
	e.ObserveApplied(l, change, string(change.Patch), int64(len(result)), hash)
	// Confirming the version is what tells the sender its change is agreed, and
	// that it may be built on.
	if err := l.conn.Send(wsync.TypeAck, wsync.Ack{Path: change.Path, Version: change.Version}); err != nil {
		e.events.Emit(wsync.EventError, "ack %s: %v", change.Path, err)
	}
	return true, false
}

// applyDelete removes a local file, reporting whether it was safe to do so.
func (e *Engine) applyDelete(l *link, change wsync.FileChange) bool {
	d, err := e.tracker.Check(versioning.Change{
		Op:          versioning.OpDelete,
		Path:        change.Path,
		BaseVersion: change.BaseVersion,
		Version:     change.Version,
		OldHash:     change.OldHash,
	})
	if err != nil {
		e.events.Emit(wsync.EventError, "check delete %s: %v", change.Path, err)
		return false
	}
	if !d.Apply {
		e.reportConflict(l, d.Conflict, change, false)
		return false
	}
	abs, err := security.SecureJoin(e.ws.Root, change.Path)
	if err != nil {
		e.events.Emit(wsync.EventError, "reject delete %s: %v", change.Path, err)
		return false
	}
	if err := removeIfPresent(abs); err != nil {
		e.events.Emit(wsync.EventError, "delete %s: %v", change.Path, err)
		return false
	}
	if err := e.tracker.Forget(change.Path); err != nil {
		e.events.Emit(wsync.EventError, "forget %s: %v", change.Path, err)
		return false
	}
	l.cache.Forget(change.Path)
	e.suppressGone(change.Path)
	e.events.Emit(wsync.EventPatch, "%s deleted by %s", change.Path, l.peerID)
	e.ObserveDeleteApplied(l, change)
	// Tell the peer its delete landed. Without this the tombstone it recorded
	// stays marked as an unconfirmed local change forever, and its next write to
	// this path is refused as a conflict against work it has already applied.
	if err := l.conn.Send(wsync.TypeAck, wsync.Ack{Path: change.Path, Version: change.Version}); err != nil {
		e.events.Emit(wsync.EventError, "ack delete %s: %v", change.Path, err)
	}
	return true
}

// confirmGoneAck upgrades a tombstone to agreed state once the peer confirms a
// delete. The path has no file on disk, so there is no size or hash to read:
// the tombstone is confirmed exactly as it stands, carrying the peer's version.
func (e *Engine) confirmGoneAck(l *link, ack wsync.Ack) {
	if _, err := e.ws.ConfirmFile(ack.Path, 0, "", ack.Version, l.peerID); err != nil {
		e.events.Emit(wsync.EventError, "record delete ack for %s: %v", ack.Path, err)
	}
}

// reportConflict records a refusal and tells the peer, so a sender is never left
// believing its change was applied.
//
// It is used for changes with no body to preserve, such as a refused patch. A
// refused full transfer is recorded by finishIncoming instead, once the incoming
// content has actually been written to a conflict copy.
func (e *Engine) reportConflict(l *link, c *versioning.Conflict, change wsync.FileChange, resendFull bool) {
	if c != nil {
		id, err := e.tracker.Record(*c, l.peerID)
		if err != nil {
			e.events.Emit(wsync.EventError, "record conflict on %s: %v", c.Path, err)
		} else {
			e.events.Emit(wsync.EventConflict, "conflict #%d on %s (%s)", id, c.Path, c.Kind)
		}
	}
	e.sendConflict(l, change, conflictKind(c), "", resendFull)
	// The local side keeps its own content and the peer's is preserved elsewhere,
	// so this is reported as a conflict rather than as an applied change. The
	// version machinery that produced the conflict already carries the specifics
	// and the human event line above names them.
	e.ObserveConflict(l, change, conflictKind(c), "", "")
}

func conflictKind(c *versioning.Conflict) string {
	if c == nil {
		return store.ConflictRemoteNewer
	}
	return c.Kind
}

// sendConflict reports a refused change to the peer that sent it.
func (e *Engine) sendConflict(l *link, change wsync.FileChange, kind, reason string, resendFull bool) {
	_, localHash, _, err := e.tracker.Local(change.Path)
	if err != nil {
		localHash = ""
	}
	version, _, err := e.tracker.Base(change.Path)
	if err != nil {
		version = 0
	}
	report := wsync.ConflictReport{
		Path:          change.Path,
		Kind:          kind,
		BaseVersion:   change.BaseVersion,
		LocalVersion:  version,
		RemoteVersion: change.Version,
		LocalHash:     localHash,
		RemoteHash:    change.NewHash,
		ResendFull:    resendFull,
		Reason:        reason,
	}
	if err := l.conn.Send(wsync.TypeConflict, report); err != nil {
		e.events.Emit(wsync.EventError, "report conflict on %s: %v", change.Path, err)
	}
}

// SendControl relays one opaque supervisor frame to every attached peer.
//
// It reports how many peers the frame reached alongside the first failure, so a
// caller relaying a periodic heartbeat can tell "nobody is attached" from "the
// link broke" without inspecting the error alone.
//
// Nothing is queued: a supervisor frame is a live signal, and delivering a
// stale one after a peer reconnects would be worse than dropping it. The
// supervisor owns its own cadence and resends.
func (e *Engine) SendControl(payload json.RawMessage) (int, error) {
	if len(payload) == 0 {
		return 0, fmt.Errorf("%w: control payload is empty", wsync.ErrProtocol)
	}
	if len(payload) > wsync.MaxControlBytes {
		return 0, fmt.Errorf("%w: control payload of %d bytes exceeds the %d limit", wsync.ErrProtocol, len(payload), wsync.MaxControlBytes)
	}
	frame := wsync.Control{PeerID: e.ws.PeerID, Payload: payload}

	delivered := 0
	var firstErr error
	for _, l := range e.snapshotPeers() {
		if err := l.conn.Send(wsync.TypeControl, frame); err != nil {
			e.events.Emit(wsync.EventError, "relay control to %s: %v", l.peerID, err)
			if firstErr == nil {
				firstErr = fmt.Errorf("relay CONTROL to %s: %w", l.peerID, err)
			}
			continue
		}
		delivered++
	}
	return delivered, firstErr
}

// handleConflictReport reacts to a peer refusing one of our changes.
func (e *Engine) handleConflictReport(l *link, report wsync.ConflictReport) {
	e.events.Emit(wsync.EventConflict, "peer %s refused %s: %s", l.peerID, report.Path, describe(report.Kind, report.Reason))
	if !report.ResendFull {
		// The peer's copy was preserved, and the local file is untouched. There
		// is nothing to retry: the two sides have genuinely diverged and the user
		// has to choose.
		return
	}
	// The peer asked for the whole file. Resending it lets the change land when
	// the content is in fact the same, and turns into a preserved copy when it is
	// not, which is the desired outcome either way.
	go func() {
		if err := e.resendFull(l, report.Path); err != nil {
			e.events.Emit(wsync.EventError, "resend %s: %v", report.Path, err)
		}
	}()
}

func describe(kind, reason string) string {
	if reason != "" {
		return kind + ": " + reason
	}
	return kind
}

// resendFull sends a file's current content, ignoring the patch path.
func (e *Engine) resendFull(l *link, path string) error {
	abs, err := security.SecureJoin(e.ws.Root, path)
	if err != nil {
		return err
	}
	content, err := readFile(abs)
	if err != nil {
		return err
	}
	_, hash, err := e.ws.LocalExists(path)
	if err != nil {
		return err
	}
	version, _, err := e.tracker.Base(path)
	if err != nil {
		return err
	}
	return e.sendFile(l, wsync.FileChange{
		Op:          wsync.OpUpdate,
		Path:        path,
		BaseVersion: version,
		Version:     version,
		NewHash:     hash,
		Size:        int64(len(content)),
		Full:        true,
	})
}

// watchLoop turns local filesystem changes into peer updates.
func (e *Engine) watchLoop() {
	defer e.wg.Done()
	events := e.watch.Events()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-e.closed:
			return
		case ev, ok := <-events:
			if !ok {
				return
			}
			if err := e.onLocalChange(ev); err != nil {
				e.events.Emit(wsync.EventError, "local change %s: %v", ev.Path, err)
			}
		}
	}
}

// onLocalChange decides what a watcher event means and sends it.
func (e *Engine) onLocalChange(ev watcher.Event) error {
	if ev.Kind == watcher.EventChmod {
		return nil
	}
	// The ignore set is the same one the manifest walk uses, so anything excluded
	// from synchronising is excluded here too. Checking it here means a stray file
	// in an ignored directory is never even hashed.
	if e.ws.Ignore.ShouldIgnore(ev.Path) {
		return nil
	}
	if e.isSuppressed(ev.Path) {
		// This is the watcher noticing our own write of a remote change. Sending
		// it back would bounce the change between peers indefinitely.
		return nil
	}
	peers := e.snapshotPeers()
	if len(peers) == 0 {
		return nil
	}

	change, err := e.buildChange(ev)
	if err != nil {
		if errors.Is(err, errNoChange) {
			return nil
		}
		return err
	}
	if change == nil {
		return nil
	}

	e.events.Emit(wsync.EventWatcher, "%s %s", ev.Path, change.Op)

	sent := 0
	var sentPatch string
	for _, l := range peers {
		patch, err := e.sendChange(l, change)
		if err != nil {
			// One peer failing must not stop the others from being told.
			e.events.Emit(wsync.EventError, "send %s to %s: %v", change.Path, l.peerID, err)
			continue
		}
		// The first successful send reports the body. Every peer is sent the same
		// diff against the same cached base, and a consumer wants one local edit
		// reported once rather than once per destination.
		if sent == 0 {
			sentPatch = patch
		}
		sent++
	}
	if sent == 0 {
		return fmt.Errorf("no peer accepted %s", change.Path)
	}
	e.ObserveLocalChange(change, sentPatch)
	// The version only advances once a peer has it. A failed send leaves the
	// agreed version behind, and the catch-up resync brings that peer forward
	// rather than reporting a conflict it did not cause.
	//
	// The row is marked as a local change rather than an agreed one, because
	// acceptance has not come back yet. It is upgraded to agreed when the peer's
	// ACK arrives, and until then nothing else may be applied over it.
	if change.Version > 0 {
		// A delete is recorded as a tombstone: a row with no hash, meaning "agreed
		// that this path does not exist". Dropping the row instead would erase the
		// fact that a delete happened, and a peer that had not seen it would then
		// be free to recreate the path with no conflict raised.
		hash := change.NewHash
		if change.Op == wsync.OpDelete {
			hash = ""
		}
		if _, err := e.ws.AdvanceFile(change.Path, change.Size, hash, change.Version); err != nil {
			e.events.Emit(wsync.EventError, "record %s: %v", change.Path, err)
		}
	}
	return nil
}

var errNoChange = errors.New("nothing to send")

// buildChange turns a filesystem event into a change, or reports that there is
// nothing worth sending.
func (e *Engine) buildChange(ev watcher.Event) (*wsync.FileChange, error) {
	exists, hash, err := e.ws.LocalExists(ev.Path)
	if err != nil {
		return nil, err
	}
	agreedVersion, agreedHash, err := e.tracker.Base(ev.Path)
	if err != nil {
		return nil, err
	}

	// A path that is neither on disk nor agreed on is noise: a temporary file, a
	// partially written file the watcher saw on its way past, or a file the user
	// deleted and recreated within the debounce window.
	if !exists && agreedVersion == 0 {
		return nil, errNoChange
	}

	if !exists {
		return &wsync.FileChange{
			Op:          wsync.OpDelete,
			Path:        ev.Path,
			BaseVersion: agreedVersion,
			Version:     agreedVersion + 1,
			OldHash:     agreedHash,
		}, nil
	}

	abs, err := security.SecureJoin(e.ws.Root, ev.Path)
	if err != nil {
		return nil, err
	}
	content, err := readFile(abs)
	if err != nil {
		return nil, err
	}
	// The content already agrees with the store, so the event was noise. This is
	// the common case: the watcher fires on mtime changes that do not alter bytes.
	if hash == agreedHash {
		return nil, errNoChange
	}

	change := &wsync.FileChange{
		Op:          wsync.OpUpdate,
		Path:        ev.Path,
		BaseVersion: agreedVersion,
		Version:     agreedVersion + 1,
		OldHash:     agreedHash,
		NewHash:     hash,
		Size:        int64(len(content)),
	}
	if agreedVersion == 0 {
		change.Op = wsync.OpCreate
	}
	return change, nil
}

// sendChange sends one change, choosing a patch or a whole file. It returns the
// unified diff it sent, or an empty string when the content travelled whole, so
// the caller can describe the change it actually transmitted.
func (e *Engine) sendChange(l *link, change *wsync.FileChange) (string, error) {
	// A patch is only worth building if the base content is known and the result
	// would be smaller than resending the file. Otherwise the full path is
	// simpler and no more expensive.
	// A delete has no body to diff or to send: the absence of the file is the
	// whole message. Treating it as a content change would try to read a file
	// that by definition no longer exists, and the delete would never leave.
	if change.Op == wsync.OpDelete {
		return "", e.sendDelete(l, *change)
	}

	base, haveBase := l.cache.Get(change.Path)
	if haveBase && change.Op != wsync.OpCreate {
		abs, err := security.SecureJoin(e.ws.Root, change.Path)
		if err != nil {
			return "", err
		}
		newContent, err := readFile(abs)
		if err != nil {
			return "", err
		}
		if isText(base) && isText(newContent) {
			if patch, err := diff.Unified(base, newContent, defaultContextLines); err == nil {
				if len(patch) < len(newContent) {
					patched := *change
					patched.Patch = []byte(patch)
					return patch, l.conn.Send(wsync.TypePatch, wsync.Changes{
						WorkspaceID: e.ws.ID,
						PeerID:      e.ws.PeerID,
						Changes:     []wsync.FileChange{patched},
					})
				}
			}
		}
	}
	return "", e.sendFile(l, *change)
}

const defaultContextLines = 3

// sendDelete announces a deletion. Full is false because there is nothing to
// follow: a receiver that expected a body would wait for frames that never come.
func (e *Engine) sendDelete(l *link, change wsync.FileChange) error {
	l.sendMu.Lock()
	defer l.sendMu.Unlock()

	change.Full = false
	change.Patch = nil
	return l.conn.Send(wsync.TypePatch, wsync.Changes{
		WorkspaceID: e.ws.ID,
		PeerID:      e.ws.PeerID,
		Changes:     []wsync.FileChange{change},
	})
}

// sendFile announces a change and streams the content after it.
//
// The whole transfer is serialised on the link, because a change and its body
// are several frames and must not be interleaved with another transfer.
func (e *Engine) sendFile(l *link, change wsync.FileChange) error {
	l.sendMu.Lock()
	defer l.sendMu.Unlock()

	// The receiver keys off this flag to decide whether to expect a body, so it
	// has to be set on the announcement. Announcing a change and then sending a
	// body for it without this set leaves the peer waiting for a patch and then
	// rejecting the transfer frames as unsolicited.
	change.Full = true
	change.Patch = nil
	if err := l.conn.Send(wsync.TypePatch, wsync.Changes{
		WorkspaceID: e.ws.ID,
		PeerID:      e.ws.PeerID,
		Changes:     []wsync.FileChange{change},
	}); err != nil {
		return err
	}
	abs, err := security.SecureJoin(e.ws.Root, change.Path)
	if err != nil {
		return err
	}
	content, err := readFile(abs)
	if err != nil {
		return err
	}
	// The file may have changed since the hash was taken. Announcing a hash that
	// does not match the body would make the peer reject its own delivery, so the
	// announcement is corrected instead of the transfer being corrupted.
	actual, err := hashBytes(content)
	if err != nil {
		return err
	}
	if change.NewHash != actual {
		change.NewHash = actual
		change.Size = int64(len(content))
		// The peer has already been told the old hash, so the corrected values
		// have to follow. Sending a second announcement is cheaper than having the
		// peer discard a correct file.
		if err := l.conn.Send(wsync.TypePatch, wsync.Changes{
			WorkspaceID: e.ws.ID,
			PeerID:      e.ws.PeerID,
			Changes:     []wsync.FileChange{change},
		}); err != nil {
			return err
		}
	}

	for offset := 0; offset < len(content) || offset == 0; offset += wsync.ChunkSize {
		end := offset + wsync.ChunkSize
		done := false
		if end >= len(content) {
			end = len(content)
			done = true
		}
		if err := l.conn.Send(wsync.TypeFileTransfer, wsync.FileTransfer{
			Path:   change.Path,
			Offset: int64(offset),
			Data:   content[offset:end],
			Done:   done,
		}); err != nil {
			return err
		}
		if done {
			break
		}
	}
	return l.conn.Send(wsync.TypeFileComplete, wsync.FileComplete{
		Path:    change.Path,
		Size:    int64(len(content)),
		Hash:    change.NewHash,
		Version: change.Version,
	})
}

// heartbeatLoop probes peers so a dead connection is noticed in seconds.
func (e *Engine) heartbeatLoop() {
	defer e.wg.Done()
	ticker := time.NewTicker(e.pingInterval())
	defer ticker.Stop()
	n := 0
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-e.closed:
			return
		case <-ticker.C:
			n++
			for _, l := range e.snapshotPeers() {
				ping := wsync.Ping{ID: fmt.Sprintf("%d", n), Sent: e.clock().UTC()}
				if err := l.conn.Send(wsync.TypePing, ping); err != nil {
					// A failed write means the peer is gone. Dropping it here lets
					// the read loop notice on its own shortly after.
					e.events.Emit(wsync.EventDisconnected, "peer %s did not answer: %v", l.peerID, err)
				}
			}
		}
	}
}

// resyncLoop periodically reconciles, which is what recovers changes that a
// watcher event or a live frame missed.
func (e *Engine) resyncLoop() {
	defer e.wg.Done()
	ticker := time.NewTicker(e.resyncInterval())
	defer ticker.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-e.closed:
			return
		case <-ticker.C:
			e.Resync()
		}
	}
}

// Resync brings every attached peer up to date, sending the local side of the
// difference. It is exported so a session can request one after connecting.
func (e *Engine) Resync() {
	for _, l := range e.snapshotPeers() {
		if err := e.resyncPeer(l); err != nil {
			e.events.Emit(wsync.EventError, "resync with %s: %v", l.peerID, err)
		}
	}
}

// resyncPeer sends this peer's files that the remote is not known to have.
func (e *Engine) resyncPeer(l *link) error {
	entries, err := workspace.LocalEntries(e.ws.Root, e.ws.Ignore)
	if err != nil {
		return err
	}
	paths := make([]string, 0, len(entries))
	for path := range entries {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	sent := 0
	for _, path := range paths {
		row, err := e.ws.Store.GetFile(path)
		version := int64(0)
		if err == nil {
			version = row.Version
		}
		if known, ok := l.informedVersion(path); ok && known >= version {
			// The remote has been told about this version already. Re-sending
			// every file on every tick would turn a quiet workspace into constant
			// traffic.
			continue
		}
		abs, err := security.SecureJoin(e.ws.Root, path)
		if err != nil {
			continue
		}
		content, err := readFile(abs)
		if err != nil {
			continue
		}
		hash, err := hashBytes(content)
		if err != nil {
			continue
		}
		if err := e.sendFile(l, wsync.FileChange{
			Op:          wsync.OpUpdate,
			Path:        path,
			BaseVersion: version,
			Version:     version,
			NewHash:     hash,
			Size:        int64(len(content)),
			Full:        true,
		}); err != nil {
			return err
		}
		l.noteInformed(path, version)
		sent++
	}
	if sent > 0 {
		e.events.Emit(wsync.EventInfo, "resynced %d file(s) to %s", sent, l.peerID)
		return l.conn.Send(wsync.TypeSyncDone, wsync.SyncDone{Files: sent})
	}
	return nil
}

// suppress records that this engine wrote path, so the resulting watcher event
// can be recognised as an echo.
func (e *Engine) suppress(path, hash string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.suppressed[path] = suppression{hash: hash, at: e.clock()}
}

// suppressGone records a delete this engine performed.
func (e *Engine) suppressGone(path string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.suppressed[path] = suppression{hash: "", at: e.clock()}
}

// isSuppressed reports whether a watcher event is the echo of this engine's own
// write, and forgets the record either way.
//
// The check is on content, not just on the path. Suppressing by path alone would
// swallow a genuine edit made moments later, which is precisely the edit a user is
// most likely to be making.
func (e *Engine) isSuppressed(path string) bool {
	e.mu.Lock()
	entry, ok := e.suppressed[path]
	if ok {
		delete(e.suppressed, path)
	}
	e.mu.Unlock()
	if !ok {
		return false
	}
	if e.clock().Sub(entry.at) > DefaultSuppressionTTL {
		return false
	}
	exists, hash, err := e.ws.LocalExists(path)
	if err != nil {
		return false
	}
	if entry.hash == "" {
		return !exists
	}
	return exists && hash == entry.hash
}

// resolve maps a workspace-relative path to an absolute one, creating the
// parent directory if it is missing.
//
// The order matters. SecureJoin checks that every component stays inside the
// root, which is why it is used at all, but it cannot resolve a path whose
// directory does not exist yet and the first file in a new subdirectory has to be
// writable. So the path is validated first, the directory is created, and the
// containment check runs again on the resolved path.
func (e *Engine) resolve(rel string) (string, error) {
	if err := security.ValidateRelPath(rel); err != nil {
		return "", err
	}
	if dir := filepath.Dir(rel); dir != "." && dir != "" {
		if err := os.MkdirAll(filepath.Join(e.ws.Root, filepath.FromSlash(dir)), 0o755); err != nil {
			return "", err
		}
	}
	return security.SecureJoin(e.ws.Root, rel)
}

// writeFile puts content at a workspace-relative path atomically.
func (e *Engine) writeFile(rel string, content []byte) error {
	abs, err := e.resolve(rel)
	if err != nil {
		return err
	}
	return atomicWrite(abs, content)
}

// contentCache remembers the last content a peer and this engine agreed on, so a
// later edit can leave as a patch.
//
// It is a plain map with a byte budget rather than a full LRU: the cache exists
// to make the common case cheap, and evicting the oldest entries is good enough
// when a miss only costs a full transfer.
type contentCache struct {
	mu      sync.Mutex
	max     int64
	maxFile int64
	used    int64
	entries map[string][]byte
	order   []string
}

func newContentCache(maxTotal, maxFile int64) *contentCache {
	return &contentCache{max: maxTotal, maxFile: maxFile, entries: map[string][]byte{}}
}

func (c *contentCache) Get(path string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	content, ok := c.entries[path]
	if !ok {
		return nil, false
	}
	// A copy, so a caller cannot mutate the cached bytes and make the cache
	// disagree with what was actually agreed.
	out := make([]byte, len(content))
	copy(out, content)
	return out, true
}

func (c *contentCache) Put(path string, content []byte) {
	if int64(len(content)) > c.maxFile {
		// Too large to be worth remembering. A patch would not beat resending it.
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if old, ok := c.entries[path]; ok {
		c.used -= int64(len(old))
		delete(c.entries, path)
		for i, k := range c.order {
			if k == path {
				c.order = append(c.order[:i], c.order[i+1:]...)
				break
			}
		}
	}
	if c.used+int64(len(content)) > c.max {
		c.evictLocked()
	}
	stored := make([]byte, len(content))
	copy(stored, content)
	c.entries[path] = stored
	c.used += int64(len(stored))
	c.order = append(c.order, path)
}

// evictLocked drops the oldest half of the cache, which is cheaper than tracking
// precise recency and only has to keep the budget honest.
func (c *contentCache) evictLocked() {
	half := len(c.order) / 2
	if half == 0 && len(c.order) > 0 {
		half = 1
	}
	for _, path := range c.order[:half] {
		if content, ok := c.entries[path]; ok {
			c.used -= int64(len(content))
			delete(c.entries, path)
		}
	}
	c.order = append([]string(nil), c.order[half:]...)
	if c.used < 0 {
		c.used = 0
	}
}

func (c *contentCache) Forget(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if old, ok := c.entries[path]; ok {
		c.used -= int64(len(old))
		delete(c.entries, path)
	}
	for i, k := range c.order {
		if k == path {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
}

// isText reports whether a file is worth diffing. Binary content is sent whole,
// because a line diff of it is meaningless and applying one would corrupt it.
func isText(content []byte) bool {
	if len(content) == 0 {
		return true
	}
	if bytes.IndexByte(content, 0) >= 0 {
		return false
	}
	if !utf8.Valid(content) {
		return false
	}
	// A very long line defeats a line-based diff, which allocates per line.
	return !strings.Contains(string(content), "\x00")
}
