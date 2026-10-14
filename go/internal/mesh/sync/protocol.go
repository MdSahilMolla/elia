// Package sync defines the wire protocol spoken between peers and the session
// that drives it. Transport details live in the p2p package; nothing here knows
// whether the bytes travel over TCP today or something else tomorrow.
package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"elia-go/internal/mesh/p2p"
)

// MessageType identifies a protocol frame.
type MessageType string

// The message set. Only the subset used by milestones 1-3 carries behaviour
// today; the rest are declared so the protocol has a stable shape and both
// peers agree on the vocabulary.
const (
	TypeHello         MessageType = "HELLO"
	TypeAuth          MessageType = "AUTH"
	TypeWorkspaceInfo MessageType = "WORKSPACE_INFO"
	TypeManifest      MessageType = "MANIFEST"
	TypeFileRequest   MessageType = "FILE_REQUEST"
	TypeFileTransfer  MessageType = "FILE_TRANSFER"
	TypeFileComplete  MessageType = "FILE_COMPLETE"
	TypeAck           MessageType = "ACK"
	TypeError         MessageType = "ERROR"

	// TypeReconnect opens a session for an already-paired member. It carries no
	// secret: after the first pairing, each side pins the other's certificate,
	// and mutual TLS against a pinned certificate is the credential.
	TypeReconnect MessageType = "RECONNECT"

	// The live-sync message set. These were reserved for phases 4-7 and are now
	// in use: a session stays open after the initial sync and exchanges them for
	// as long as both peers are attached.
	//
	// TypePatch carries local edits to an attached peer.
	TypePatch MessageType = "PATCH"
	// TypeSyncDone closes out a batch of changes, so a receiver knows when the
	// sender has nothing further and can report the batch as complete.
	TypeSyncDone MessageType = "SYNC_DONE"
	// TypeConflict reports a change that could not be applied, so the peer that
	// sent it is told rather than left believing it was applied.
	TypeConflict MessageType = "CONFLICT"
	// TypePing and TypePong detect a peer that has gone away without closing its
	// connection, which TCP would otherwise keep reporting as healthy. TCP
	// notices a closed socket immediately but a silently dropped network only
	// after a retransmission timeout measured in minutes, which is far too long
	// for a sync session that is supposed to feel live.
	TypePing MessageType = "PING"
	TypePong MessageType = "PONG"
	// TypeLeave is a clean goodbye, so the peer reports a disconnect rather than
	// a failure.
	TypeLeave MessageType = "LEAVE"
	// TypeControl relays an opaque supervisor frame between peers.
	TypeControl MessageType = "CONTROL"
)

// Envelope is the outer shape of every frame. The payload stays raw so a
// receiver can dispatch on Type and decode only what it needs.
type Envelope struct {
	Type    MessageType       `json:"type"`
	Payload json.RawMessage   `json:"payload,omitempty"`
	Sent    time.Time         `json:"sent,omitempty"`
	Meta    map[string]string `json:"meta,omitempty"`
}

// FileEntry is one row of a workspace manifest.
type FileEntry struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Hash    string `json:"hash"`
	Version int64  `json:"version"`
}

// Lookup finds one entry in the manifest.
func (m *Manifest) Lookup(path string) (FileEntry, bool) {
	for _, f := range m.Files {
		if f.Path == path {
			return f, true
		}
	}
	return FileEntry{}, false
}

// Hello is the first frame either peer sends.
type Hello struct {
	WorkspaceID string `json:"workspace_id"`
	PeerID      string `json:"peer_id"`
	Role        string `json:"role"`
	Protocol    int    `json:"protocol"`
	Nonce       string `json:"nonce"`
	DisplayName string `json:"display_name,omitempty"`
}

// ProtocolVersion is the current wire protocol revision.
const ProtocolVersion = 1

// Auth proves possession of the join secret. The proof is an HMAC over both
// peers' nonces, so the secret itself never crosses the wire and the transcript
// is bound in both directions.
type Auth struct {
	Proof   string `json:"proof"`
	Nonce   string `json:"nonce"`
	Summary string `json:"summary"`
}

// Reconnect is the code-free handshake for a member that has already paired.
// It repeats the nonces so a captured frame cannot be replayed into a later
// session, but authenticates on pinned certificates rather than a shared secret.
type Reconnect struct {
	WorkspaceID string `json:"workspace_id"`
	PeerID      string `json:"peer_id"`
	Protocol    int    `json:"protocol"`
	Nonce       string `json:"nonce"`
}

// WorkspaceInfo describes the workspace being joined.
type WorkspaceInfo struct {
	WorkspaceID string   `json:"workspace_id"`
	Name        string   `json:"name"`
	FileCount   int      `json:"file_count"`
	TotalSize   int64    `json:"total_size"`
	IgnoreRules []string `json:"ignore_rules,omitempty"`
}

// Manifest is the full inventory a joining peer compares against its own.
type Manifest struct {
	WorkspaceID string      `json:"workspace_id"`
	Files       []FileEntry `json:"files"`
}

// FileRequest asks for specific paths. Every path is re-validated on the
// serving side: a request is untrusted input.
type FileRequest struct {
	Paths []string `json:"paths"`
	// Preserve names paths the member wants the content of but does not intend
	// to apply, because the two sides edited them independently. The host sends
	// them; the member writes them to a conflict copy and leaves its own file
	// alone. Without this the member could only refuse to sync, and the
	// incoming version would simply be lost.
	Preserve []string `json:"preserve,omitempty"`
}

// FileTransfer carries one chunk of a file's contents, base64-encoded in JSON.
type FileTransfer struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset"`
	Data   []byte `json:"data"`
	Done   bool   `json:"done"`
}

// FileComplete marks the end of a file's transfer.
type FileComplete struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Hash    string `json:"hash"`
	Version int64  `json:"version"`
}

// Ack confirms a file landed at a given version.
type Ack struct {
	Path    string `json:"path"`
	Version int64  `json:"version"`
}

// MaxControlBytes bounds one relayed control frame.
//
// A frame is opaque here, so this side cannot predict how large a supervisor's
// payload is; the cap is what stops a runaway or hostile caller from pushing
// unbounded data through a link opened for file sync. It is generous relative
// to what the supervisor actually sends, so hitting it means a bug rather than
// a legitimate message.
const MaxControlBytes = 512 << 10

// Control is a supervisor frame relayed verbatim between peers.
//
// This side deliberately does not interpret the payload. It was written by the
// supervisor at one end and is read by the supervisor at the other; the relay
// only guarantees that both ends sit behind the same authenticated,
// pinned-certificate link. That is enough, because the supervisor has already
// authenticated this peer — relaying its bytes adds no exposure that a direct
// connection would not have had.
type Control struct {
	// PeerID is the sending side's transport identity. It is filled in here
	// rather than read from the payload, so a supervisor cannot attribute its
	// own frame to someone else.
	PeerID string `json:"peer_id,omitempty"`
	// Payload is the supervisor's frame, forwarded unchanged.
	Payload json.RawMessage `json:"payload"`
}

// ControlObserver receives one relayed control frame. A nil observer discards
// them, which is the correct behaviour for a consumer that does not speak the
// supervisor protocol.
type ControlObserver func(Control)

// Observe delivers a frame, discarding it if the observer is nil.
func (o ControlObserver) Observe(frame Control) {
	if o == nil {
		return
	}
	o(frame)
}

// ErrorMsg reports a protocol-level failure.
type ErrorMsg struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error codes carried in ErrorMsg.
const (
	CodeAuthFailed      = "AUTH_FAILED"
	CodeCodeInvalid     = "CODE_INVALID"
	CodeNotMember       = "NOT_MEMBER"
	CodeBadPath         = "BAD_PATH"
	CodeTooLarge        = "TOO_LARGE"
	CodeHashMismatch    = "HASH_MISMATCH"
	CodeRateLimited     = "RATE_LIMITED"
	CodeVersionConflict = "VERSION_CONFLICT"
	CodeInternal        = "INTERNAL"
)

// ErrProtocol marks a malformed or unexpected frame.
var ErrProtocol = errors.New("protocol error")

// ErrClosed means the connection ended cleanly.
var ErrClosed = errors.New("connection closed")

// Conn is a typed wrapper over a p2p connection: it encodes and decodes
// envelopes and serialises writes, so callers exchange Go values.
type Conn struct {
	raw *p2p.Conn

	wmu sync.Mutex
	enc *json.Encoder

	mu     sync.Mutex
	closed bool
}

// NewConn wraps a transport connection.
func NewConn(raw *p2p.Conn) *Conn {
	return &Conn{raw: raw}
}

// Send marshals and writes one message.
func (c *Conn) Send(t MessageType, payload any) error {
	env := Envelope{Type: t, Sent: time.Now().UTC()}
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("marshal %s: %w", t, err)
		}
		env.Payload = raw
	}

	data, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("marshal envelope %s: %w", t, err)
	}

	c.wmu.Lock()
	defer c.wmu.Unlock()
	if err := c.raw.WriteFrame(data); err != nil {
		return fmt.Errorf("send %s: %w", t, err)
	}
	return nil
}

// Receive reads one message. It returns ErrClosed when the peer disconnects.
func (c *Conn) Receive() (MessageType, json.RawMessage, error) {
	data, err := c.raw.ReadFrame()
	if err != nil {
		return "", nil, err
	}

	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return "", nil, fmt.Errorf("%w: decode envelope: %v", ErrProtocol, err)
	}
	if env.Type == "" {
		return "", nil, fmt.Errorf("%w: message has no type", ErrProtocol)
	}
	if !knownTypes[env.Type] {
		// Refusing unknown types keeps the dispatch switch total: every frame
		// that arrives is one this build knows how to handle, rather than
		// something silently ignored.
		return "", nil, fmt.Errorf("%w: unknown message type %q", ErrProtocol, env.Type)
	}
	return env.Type, env.Payload, nil
}

// knownTypes is the complete set of message types this build accepts. A peer
// running a different revision is rejected at the frame level instead of
// producing confusing behaviour deeper in the engine.
var knownTypes = map[MessageType]bool{
	TypeHello:         true,
	TypeAuth:          true,
	TypeWorkspaceInfo: true,
	TypeManifest:      true,
	TypeFileRequest:   true,
	TypeFileTransfer:  true,
	TypeFileComplete:  true,
	TypeAck:           true,
	TypeConflict:      true,
	TypePing:          true,
	TypePong:          true,
	TypeLeave:         true,
	TypeError:         true,
	TypeReconnect:     true,
	TypePatch:         true,
	TypeSyncDone:      true,
	TypeControl:       true,
}

// KnownTypes lists the accepted message types, for logging and diagnostics.
func KnownTypes() []string {
	out := make([]string, 0, len(knownTypes))
	for t := range knownTypes {
		out = append(out, string(t))
	}
	sort.Strings(out)
	return out
}

// ReceiveInto reads one message and decodes its payload into dst, checking
// that the type matches.
func (c *Conn) ReceiveInto(want MessageType, dst any) error {
	got, payload, err := c.Receive()
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("%w: expected %s, got %s", ErrProtocol, want, got)
	}
	if dst == nil || len(payload) == 0 {
		return nil
	}
	if err := json.Unmarshal(payload, dst); err != nil {
		return fmt.Errorf("%w: decode %s payload: %v", ErrProtocol, want, err)
	}
	return nil
}

// Expect reads one message, requiring it to be the wanted type.
func (c *Conn) Expect(want MessageType) (json.RawMessage, error) {
	got, payload, err := c.Receive()
	if err != nil {
		return nil, err
	}
	if got != want {
		return nil, fmt.Errorf("%w: expected %s, got %s", ErrProtocol, want, got)
	}
	return payload, nil
}

// RemoteAddr is the peer's network address.
func (c *Conn) RemoteAddr() string { return c.raw.RemoteAddr().String() }

// RemoteCertSHA256 is the hex fingerprint of the peer's certificate.
func (c *Conn) RemoteCertSHA256() string {
	if cert := c.raw.RemoteCert(); cert != nil {
		return p2p.CertFingerprintHex(cert)
	}
	return ""
}

// SetReadDeadline bounds how long a read may block.
func (c *Conn) SetReadDeadline(t time.Time) error { return c.raw.SetReadDeadline(t) }

// SetDeadline bounds reads and writes.
func (c *Conn) SetDeadline(t time.Time) error { return c.raw.SetDeadline(t) }

// Close shuts the connection down.
func (c *Conn) Close() error {
	c.mu.Lock()
	already := c.closed
	c.closed = true
	c.mu.Unlock()
	if already {
		return nil
	}
	return c.raw.Close()
}

// Closed reports whether Close has been called.
func (c *Conn) Closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// Event is a session-level notification surfaced to the CLI, so both peers can
// print a live log while staying attached in the foreground.
type Event struct {
	Kind    string
	Message string
	Time    time.Time
}

// Event kinds.
const (
	EventConnected    = "connected"
	EventDisconnected = "disconnected"
	EventSyncStart    = "sync-start"
	EventSyncProgress = "sync-progress"
	EventSyncComplete = "sync-complete"
	EventError        = "error"
	EventInfo         = "info"
	// EventConflict is separate from EventError: a conflict is not a failure,
	// it is a divergence the user has to resolve, and it must not read like a
	// crash in the log.
	EventConflict = "conflict"
	// EventPatch is a local edit being sent or a remote edit being applied.
	EventPatch = "patch"
	// EventWatcher is filesystem activity, reported so a user can tell a silent
	// session from a broken one.
	EventWatcher = "watch"
	// EventIdle means the session is attached and in sync with nothing to do.
	EventIdle = "idle"
)

// EventSink receives session events. A nil sink discards them.
type EventSink func(Event)

// Emit delivers a formatted event, discarding it if the sink is nil. Layers
// above the transport report progress through this rather than logging directly.
func (s EventSink) Emit(kind, format string, args ...any) {
	if s == nil {
		return
	}
	s(Event{Kind: kind, Message: fmt.Sprintf(format, args...), Time: time.Now().UTC()})
}

// WithTimeout wraps a context with a bounded lifetime, used for handshake and
// initial-sync phases so a silent peer cannot hang the CLI forever.
func WithTimeout(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, d)
}
