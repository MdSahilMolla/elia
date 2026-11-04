package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	stdsync "sync"
	"testing"
	"time"

	"elia-go/internal/mesh/session"
	wsync "elia-go/internal/mesh/sync"
)

// recordingControl captures what the relay forwarded.
type recordingControl struct {
	mu       stdsync.Mutex
	sent     []string
	failWith error
}

func (r *recordingControl) send(payload json.RawMessage) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failWith != nil {
		return 0, r.failWith
	}
	r.sent = append(r.sent, string(payload))
	return 1, nil
}

func (r *recordingControl) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.sent...)
}

func TestParseControlLineForwardsTheSupervisorObjectUnchanged(t *testing.T) {
	frame, err := parseControlLine(`{"type":"control","node":"nd_1","events":[{"id":"e1"}],"extra":"kept"}`)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(frame.Payload, &got); err != nil {
		t.Fatal(err)
	}
	if got["node"] != "nd_1" {
		t.Fatalf("node = %v, want nd_1", got["node"])
	}
	if got["extra"] != "kept" {
		t.Fatalf("an unrecognised field was dropped: %v", got)
	}
	events, ok := got["events"].([]any)
	if !ok || len(events) != 1 {
		t.Fatalf("events = %v, want one element", got["events"])
	}
	// The relay must not claim to be the sender: attribution belongs to the
	// supervisor, and this side only authenticates the transport.
	if frame.PeerID != "" {
		t.Fatalf("PeerID = %q, want it left to the transport", frame.PeerID)
	}
}

func TestParseControlLineRefusesWhatItCannotOwn(t *testing.T) {
	for name, line := range map[string]string{
		"not json":             `{"type":`,
		"wrong type":           `{"type":"change","events":[{}]}`,
		"nothing but type":     `{"type":"control"}`,
		"no type field":        `{"events":[{"id":"e1"}]}`,
		"type not a string":    `{"type":7,"events":[]}`,
		"the line is an array": `[{"type":"control"}]`,
		"body too large":       `{"type":"control","events":["` + strings.Repeat("x", wsync.MaxControlBytes) + `"]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseControlLine(line); err == nil {
				t.Fatalf("line was accepted: %s", line)
			}
		})
	}
}

// The relay judges only what a frame must be for the frame to be relayable: a
// JSON object carrying a `type` it recognises. Everything inside is forwarded
// whatever it is, because this side has no business knowing the supervisor's
// protocol — a value it called malformed here would be a legitimate field to the
// program that wrote it.
func TestParseControlLineForwardsContentsWhateverTheyAre(t *testing.T) {
	for name, line := range map[string]string{
		"a scalar where an array was expected": `{"type":"control","events":"nope"}`,
		"a nested object":                      `{"type":"control","meta":{"a":[1,{"b":2}]}}`,
		"an unknown field":                     `{"type":"control","surprise":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			frame, err := parseControlLine(line)
			if err != nil {
				t.Fatalf("relay refused a value it cannot judge: %v", err)
			}
			if len(frame.Payload) == 0 {
				t.Fatal("nothing was forwarded")
			}
			// The discriminator is stripped rather than relayed: it described the
			// stdio stream, and the wire envelope carries its own.
			if strings.Contains(string(frame.Payload), `"type"`) {
				t.Fatalf("the stdio discriminator leaked onto the wire: %s", frame.Payload)
			}
		})
	}
}

// The bound is per line, not per stream. A reader that treated it as a total
// budget would relay the first few frames and then go quiet for the rest of the
// session, which looks exactly like a peer that stopped talking.
func TestRelayStdinKeepsGoingPastTheLineBound(t *testing.T) {
	rec := &recordingControl{}
	relay := &session.Control{}
	relay.BindForTest(rec.send)

	// Well past any plausible per-stream limit, in many separate frames.
	var in strings.Builder
	const frames = 400
	for i := 0; i < frames; i++ {
		in.WriteString(fmt.Sprintf(`{"type":"control","node":"nd_1","events":[{"id":"e%d"}]}`+"\n", i))
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- relayStdin(ctx, strings.NewReader(in.String()), relay, nil) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("relayStdin did not return on end of input")
	}
	if got := len(rec.all()); got != frames {
		t.Fatalf("relayed %d frames, want %d", got, frames)
	}
}

// A frame offered before the peer is attached is refused, not held. The
// supervisor drives its own cadence, so the next frame carries the same state.
func TestRelayStdinSkipsAFrameOfferedBeforeThePeerIsAttached(t *testing.T) {
	rec := &recordingControl{}
	relay := &session.Control{}
	// Deliberately never bound: ErrControlNotReady is what a supervisor sees
	// during the window between pairing and the first peer arriving.
	in := strings.NewReader(`{"type":"control","events":[{"id":"e1"}]}` + "\n" + `{"type":"control","events":[{"id":"e2"}]}` + "\n")

	var reported int
	var mu stdsync.Mutex
	err := relayStdin(context.Background(), in, relay, func(error) {
		mu.Lock()
		reported++
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("an unattached peer is not a failure: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if reported == 0 {
		t.Fatal("a dropped frame must be reported, or the supervisor thinks it synced")
	}
	if got := rec.all(); len(got) != 0 {
		t.Fatalf("nothing should have been relayed, got %v", got)
	}
}

func TestRelayStdinStopsOnAMalformedLine(t *testing.T) {
	rec := &recordingControl{}
	relay := &session.Control{}
	relay.BindForTest(rec.send)
	in := strings.NewReader(`{"type":"control","events":[{"id":"e1"}]}` + "\n" + `{"type":"change"}` + "\n" + `{"type":"control","events":[{"id":"e3"}]}` + "\n")

	err := relayStdin(context.Background(), in, relay, nil)
	if err == nil {
		t.Fatal("a malformed line must end the reader rather than be skipped")
	}
	// The line before it was relayed; the one after it is not. Carrying on would
	// mean resynchronising on nothing, which is how the wrong bytes get sent.
	if got := len(rec.all()); got != 1 {
		t.Fatalf("relayed %d frames, want only the one before the bad line", got)
	}
}

func TestReadBoundedLineRefusesAnOverlongLine(t *testing.T) {
	if _, err := readBoundedLine(newTestReader(strings.Repeat("x", 100)+"\n"), 10); err == nil {
		t.Fatal("an overlong line must be refused")
	}
	got, err := readBoundedLine(newTestReader("short\n"), 10)
	if err != nil {
		t.Fatal(err)
	}
	if got != "short" {
		t.Fatalf("line = %q, want short", got)
	}
}

func newTestReader(s string) *bufio.Reader { return bufio.NewReader(strings.NewReader(s)) }

// The stdout side of the relay is read by a program written in another language
// that shares none of this one's types, so the exact bytes are the contract.
// Pinning them here is what makes a change to a field name or to key ordering
// fail on this side, rather than surfacing as a consumer silently receiving a
// frame with nothing in it.
func TestControlFramesAreWrittenAsTheConsumerExpects(t *testing.T) {
	var out strings.Builder
	f := newFrameWriter(&out)

	if err := f.control([]byte(`{"events":[{"id":"e1"}],"node":"nd_1"}`)); err != nil {
		t.Fatal(err)
	}
	// An unknown field is carried through rather than dropped: this side cannot
	// tell a field it does not recognise from one the consumer needs.
	if err := f.control([]byte(`{"events":[{"id":"e2"}],"node":"nd_2","note":{"deep":[1,2]}}`)); err != nil {
		t.Fatal(err)
	}

	want := `{"events":[{"id":"e1"}],"node":"nd_1","type":"control"}` + "\n" +
		`{"events":[{"id":"e2"}],"node":"nd_2","note":{"deep":[1,2]},"type":"control"}` + "\n"
	if got := out.String(); got != want {
		t.Fatalf("stream is\n%q\nwant\n%q", got, want)
	}
}

// A frame the sidecar accepts but delivers to nobody must be refused.
//
// This is the quietest way to lose data: the write to stdin succeeds, so the
// supervisor counts the events as sent and advances its cursor, and the peer that
// attaches a moment later is never sent them. Nothing is logged as an error and
// no test that only checks "the frame was relayed" would notice, which is why it
// is pinned here rather than left to the end-to-end runs.
func TestRelayStdinRefusesAFrameThatReachedNoPeer(t *testing.T) {
	relay := &session.Control{}
	// Bound and healthy, but with nothing attached: exactly the window between a
	// host starting and its member arriving, which is when a backlog is waiting.
	relay.BindForTest(func(json.RawMessage) (int, error) { return 0, nil })

	in := strings.NewReader(`{"type":"control","events":[{"id":"e1"}]}` + "\n")

	var reported int
	var mu stdsync.Mutex
	err := relayStdin(context.Background(), in, relay, func(error) {
		mu.Lock()
		reported++
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("a frame that reached nobody is not a relay failure: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if reported == 0 {
		t.Fatal("a frame delivered to no peer must be reported, or the supervisor advances its cursor over events nobody has")
	}
}
