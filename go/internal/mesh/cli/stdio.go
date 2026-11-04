package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	stdsync "sync"
	"time"

	"elia-go/internal/mesh/session"
	"elia-go/internal/mesh/sync"
	"elia-go/internal/mesh/workspace"
)

// stdioProtocolVersion identifies the frame contract. A consumer checks it
// before trusting the rest of the stream, so a future change to a field's
// meaning is a version bump rather than a silent reinterpretation.
const stdioProtocolVersion = 1

// Frame is one line of the NDJSON stream that `attach --stdio` writes.
//
// Every frame carries a Type so a consumer can dispatch without guessing from
// the shape. The change frame embeds the engine's ChangeEvent verbatim rather
// than restating its fields, so the wire contract has one definition.
type Frame struct {
	Type string `json:"type"`

	// ready
	Protocol        int         `json:"protocol,omitempty"`
	WorkspaceID     string      `json:"workspace_id,omitempty"`
	PeerID          string      `json:"peer_id,omitempty"`
	Role            string      `json:"role,omitempty"`
	Root            string      `json:"root,omitempty"`
	ListenAddr      string      `json:"listen_addr,omitempty"`
	Fingerprint     string      `json:"fingerprint,omitempty"`
	HostFingerprint string      `json:"host_fingerprint,omitempty"`
	Peers           []PeerFrame `json:"peers,omitempty"`

	// invite
	Code      string    `json:"code,omitempty"`
	URL       string    `json:"url,omitempty"`
	ExpiresAt time.Time `json:"expires_at,omitempty"`

	// change
	Change *sync.ChangeEvent `json:"change,omitempty"`

	// event and error
	Kind    string    `json:"kind,omitempty"`
	Message string    `json:"message,omitempty"`
	Time    time.Time `json:"time,omitempty"`
}

// PeerFrame is one peer in the ready frame. The certificate fingerprint is the
// full hex digest, unlike the twelve-character form `status` prints for a human:
// a consumer binds a node identity to this value, and a truncated one would
// match any peer sharing a prefix.
type PeerFrame struct {
	PeerID     string    `json:"peer_id"`
	Role       string    `json:"role"`
	CertSHA256 string    `json:"cert_sha256"`
	LastSeen   time.Time `json:"last_seen,omitempty"`
}

// frameWriter serialises frames onto one stream.
//
// The engine calls its observers from several goroutines, so writes are guarded.
// Each frame is marshalled in full before the lock is taken and written under
// it, so a consumer never sees a half-written line even if a write is split.
type frameWriter struct {
	mu  stdsync.Mutex
	enc *json.Encoder
	// wrote tracks whether a line has been written, so the error frame below can
	// append a newline only when it is not already at a line boundary.
	wrote bool
}

func newFrameWriter(w io.Writer) *frameWriter {
	return &frameWriter{enc: json.NewEncoder(w)}
}

func (f *frameWriter) write(fr Frame) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	// json.Encoder terminates each value with a newline, which is what makes the
	// stream line-delimited.
	if err := f.enc.Encode(fr); err != nil {
		return err
	}
	f.wrote = true
	return nil
}

func (f *frameWriter) ready(ws *workspace.Workspace, root, listen string, hostFP string) error {
	fingerprint, err := ws.FingerprintHex()
	if err != nil {
		return err
	}
	peers, err := ws.Store.Peers()
	if err != nil {
		return err
	}
	frames := make([]PeerFrame, 0, len(peers))
	for _, p := range peers {
		frames = append(frames, PeerFrame{
			PeerID:     p.PeerID,
			Role:       p.Role,
			CertSHA256: p.CertSHA256,
			LastSeen:   p.LastSeen,
		})
	}
	return f.write(Frame{
		Type:            "ready",
		Protocol:        stdioProtocolVersion,
		WorkspaceID:     ws.ID,
		PeerID:          ws.PeerID,
		Role:            ws.Role,
		Root:            root,
		ListenAddr:      listen,
		Fingerprint:     fingerprint,
		HostFingerprint: hostFP,
		Peers:           frames,
	})
}

func (f *frameWriter) change(ev sync.ChangeEvent) error {
	return f.write(Frame{Type: "change", Change: &ev})
}

// control relays a supervisor frame the peer sent.
//
// The relayed body is spliced in field for field and only the `type`
// discriminator is added, so the consumer receives the supervisor's own object
// with a marker attached rather than this process's re-description of it. Every
// value stays a raw message, so nothing here has to know what any of them mean —
// describing them with Go types would mean keeping a second copy of a contract
// that belongs to another program, and the copy would drift.
func (f *frameWriter) control(body json.RawMessage) error {
	fields := map[string]json.RawMessage{}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &fields); err != nil {
			return fmt.Errorf("decode relayed control frame: %w", err)
		}
	}
	fields["type"] = json.RawMessage(`"control"`)

	f.mu.Lock()
	defer f.mu.Unlock()
	// Encoding a raw message writes it verbatim and appends the newline that
	// keeps the stream line-delimited.
	if err := f.enc.Encode(fields); err != nil {
		return err
	}
	f.wrote = true
	return nil
}

// invite reports a join code. It is emitted in addition to the human-facing
// print, because a supervisor that spawned the host never sees the terminal and
// still has to show the user the code they must pass to the other machine.
func (f *frameWriter) invite(code, url string, expires time.Time) error {
	return f.write(Frame{Type: "invite", Code: code, URL: url, ExpiresAt: expires})
}

func (f *frameWriter) event(e sync.Event) error {
	return f.write(Frame{Type: "event", Kind: e.Kind, Message: e.Message, Time: e.Time})
}

func (f *frameWriter) failure(msg string) error {
	return f.write(Frame{Type: "error", Message: msg, Time: time.Now().UTC()})
}

// hostFingerprint returns the pinned host certificate fingerprint for a member
// workspace, or an empty string when none is recorded. The host itself pins no
// other host, so the empty case is normal rather than an error.
func hostFingerprint(ws *workspace.Workspace) string {
	pin, err := ws.GetMeta(workspace.MetaHostCert)
	if err != nil {
		return ""
	}
	return pin
}

// maxStdinControlBytes bounds one line accepted from stdin. The extra headroom
// over the relay's own cap covers the framing this process adds, so an
// oversized frame is refused by the relay rather than tripping the reader.
const maxStdinControlBytes = sync.MaxControlBytes + (64 << 10)

// relayStdin forwards supervisor control frames from a line reader to the peer.
//
// It runs until the reader ends or the context is cancelled, and is meant to be
// the only reader of that stream. Every failure is reported and then fatal to
// this reader: continuing after a malformed or oversized frame would mean
// silently skipping bytes and resynchronising on nothing, which is how a relay
// ends up forwarding the wrong thing.
//
// A frame offered before the peer is attached is refused rather than held. The
// supervisor drives its own cadence, so the next one will carry the same state.
func relayStdin(ctx context.Context, in io.Reader, controls *session.Control, onErr func(error)) error {
	// The bound is per line, not per stream: this reader runs for the life of the
	// session, so a whole-stream limit would stop relaying once enough frames had
	// gone past, which looks exactly like a peer that quietly went mute.
	reader := bufio.NewReader(in)
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		line, err := readBoundedLine(reader, maxStdinControlBytes)
		if line != "" {
			if trimmed := strings.TrimSpace(line); trimmed != "" {
				frame, perr := parseControlLine(trimmed)
				if perr != nil {
					if onErr != nil {
						onErr(perr)
					}
					return perr
				}
				delivered, serr := controls.SendControl(frame.Payload)
				if serr == nil && delivered == 0 {
					// Written successfully, delivered to nobody. The supervisor
					// reads this frame having been accepted and advances its
					// cursor past the events in it, so the peer that attaches a
					// moment later never receives them and no error is ever
					// reported. Same outcome as a not-yet-bound handle, so it is
					// treated the same way: refuse it, keep the cursor, and let
					// the next tick re-send from where it was.
					serr = fmt.Errorf("%w: no peer is attached", session.ErrControlNotReady)
				}
				if serr != nil {
					if errors.Is(serr, session.ErrControlNotReady) {
						// The peer is not attached yet. Not a failure: the
						// supervisor writes a fresh frame on its next tick.
						if onErr != nil {
							onErr(fmt.Errorf("control frame from the supervisor was not relayed: %w", serr))
						}
						continue
					}
					if onErr != nil {
						onErr(serr)
					}
					return serr
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			// A line that arrived before EOF is still processed above; only the
			// error itself ends the loop.
			if onErr != nil {
				onErr(err)
			}
			return err
		}
	}
}

// readBoundedLine reads one newline-terminated line, refusing anything longer
// than max.
//
// The reader is a pipe this process does not control, so the limit is what stops
// a stuck or hostile writer from making this process buffer without limit before
// it has even decided to relay anything.
func readBoundedLine(r *bufio.Reader, max int) (string, error) {
	var buf []byte
	for {
		chunk, isPrefix, err := r.ReadLine()
		if err != nil {
			if len(buf) > 0 {
				return string(buf), nil
			}
			return "", err
		}
		buf = append(buf, chunk...)
		if len(buf) > max {
			return "", fmt.Errorf("stdin line exceeds the %d byte limit", max)
		}
		if !isPrefix {
			return string(buf), nil
		}
	}
}

// parseControlLine reads one supervisor frame and returns it ready to relay.
//
// The frame is forwarded field for field with only the `type` discriminator
// removed. Two things follow from that, and both matter:
//
//   - An unrecognised field survives. Forwarding a fixed subset would silently
//     drop anything this build does not happen to know about, and the supervisor
//     on the other end would see a frame it had sent missing a part, with no way
//     to tell a relay bug from a short write.
//   - The body has to be a JSON object, because that is the only shape a frame
//     with named fields can be. This falls out of decoding into a map rather than
//     a struct, and it means a bare scalar is refused here instead of reaching the
//     peer as an unusable frame.
//
// Nothing else is inspected. Validating the contents would mean shipping the
// supervisor's protocol twice and keeping the two copies in step.
func parseControlLine(line string) (sync.Control, error) {
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(line), &fields); err != nil {
		return sync.Control{}, fmt.Errorf("decode control frame: %w", err)
	}
	raw, ok := fields["type"]
	if !ok {
		return sync.Control{}, errors.New("stdin frame has no type")
	}
	var kind string
	if err := json.Unmarshal(raw, &kind); err != nil {
		return sync.Control{}, fmt.Errorf("stdin frame type is not a string: %w", err)
	}
	if kind != "control" {
		return sync.Control{}, fmt.Errorf("stdin carried a %q frame, which this relay does not forward", kind)
	}

	delete(fields, "type")
	if len(fields) == 0 {
		// There is nothing to relay. Forwarding an empty frame would spend a
		// round trip telling the peer the same thing it already knows.
		return sync.Control{}, errors.New("control frame carries nothing but its type")
	}
	body, err := json.Marshal(fields)
	if err != nil {
		return sync.Control{}, fmt.Errorf("re-encode control frame: %w", err)
	}
	if len(body) > sync.MaxControlBytes {
		return sync.Control{}, fmt.Errorf("control frame body of %d bytes exceeds the %d limit", len(body), sync.MaxControlBytes)
	}
	return sync.Control{Payload: body}, nil
}
