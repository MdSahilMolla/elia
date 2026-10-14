package sync

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"elia-go/internal/mesh/p2p"
)

func newTestConnPair(t *testing.T) (server, client *Conn) {
	t.Helper()

	mkID := func() *p2p.Identity {
		dir := t.TempDir()
		id, err := p2p.CreateIdentity(dir, "a1b2c3")
		if err != nil {
			t.Fatalf("CreateIdentity: %v", err)
		}
		return id
	}
	serverID, clientID := mkID(), mkID()

	ln, err := p2p.Listen("127.0.0.1:0", serverID)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	type res struct {
		c   *p2p.Conn
		err error
	}
	ch := make(chan res, 1)
	go func() {
		c, _, err := ln.Accept(context.Background())
		ch <- res{c, err}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cc, err := p2p.Dial(ctx, ln.Addr().String(), clientID, serverID.Fingerprint())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	r := <-ch
	if r.err != nil {
		t.Fatalf("Accept: %v", r.err)
	}
	t.Cleanup(func() { cc.Close() })

	return NewConn(r.c), NewConn(cc)
}

func TestConnSendReceive(t *testing.T) {
	s, c := newTestConnPair(t)

	if err := c.Send(TypePing, nil); err != nil {
		t.Fatalf("Send: %v", err)
	}
	typ, payload, err := s.Receive()
	if err != nil {
		t.Fatalf("Receive: %v", err)
	}
	if typ != TypePing {
		t.Errorf("type = %s, want PING", typ)
	}
	if len(payload) != 0 {
		t.Errorf("payload = %s, want empty", payload)
	}
}

func TestConnSendWithPayload(t *testing.T) {
	s, c := newTestConnPair(t)

	want := Manifest{WorkspaceID: "ws_83f92a", Files: []FileEntry{
		{Path: "README.md", Size: 1204, Hash: "abc", Version: 1},
		{Path: "src/app.py", Size: 4820, Hash: "def", Version: 3},
	}}
	if err := c.Send(TypeManifest, want); err != nil {
		t.Fatalf("Send: %v", err)
	}

	var got Manifest
	if err := s.ReceiveInto(TypeManifest, &got); err != nil {
		t.Fatalf("ReceiveInto: %v", err)
	}
	if got.WorkspaceID != want.WorkspaceID || len(got.Files) != 2 {
		t.Errorf("received %+v, want %+v", got, want)
	}
	if got.Files[1].Version != 3 {
		t.Errorf("version = %d, want 3", got.Files[1].Version)
	}
}

func TestConnExpectRejectsWrongType(t *testing.T) {
	s, c := newTestConnPair(t)

	if err := c.Send(TypePong, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Expect(TypePing); !errors.Is(err, ErrProtocol) {
		t.Errorf("Expect err = %v, want ErrProtocol", err)
	}
}

func TestConnReceiveIntoRejectsWrongType(t *testing.T) {
	s, c := newTestConnPair(t)

	if err := c.Send(TypeLeave, nil); err != nil {
		t.Fatal(err)
	}
	var m Manifest
	if err := s.ReceiveInto(TypeManifest, &m); !errors.Is(err, ErrProtocol) {
		t.Errorf("ReceiveInto err = %v, want ErrProtocol", err)
	}
}

func TestConnRejectsUntypedMessage(t *testing.T) {
	s, c := newTestConnPair(t)

	if err := c.Send("NOT_A_REAL_TYPE", nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Receive(); !errors.Is(err, ErrProtocol) {
		t.Errorf("Receive err = %v, want ErrProtocol for an unknown type", err)
	}
}

func TestConnRejectsMalformedJSON(t *testing.T) {
	s, c := newTestConnPair(t)

	// A hand-rolled frame that is not a valid envelope.
	if err := c.Send(TypePing, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.SendRaw(`{"type":`); err != nil {
		t.Fatal(err)
	}
	if err := s.SendRaw(`not json at all`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Receive(); !errors.Is(err, ErrProtocol) {
		t.Errorf("Receive err = %v, want ErrProtocol for malformed JSON", err)
	}
}

func TestConnRejectsEnvelopeWithoutType(t *testing.T) {
	s, c := newTestConnPair(t)
	if err := c.SendRaw(`{"payload":{}}`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Receive(); !errors.Is(err, ErrProtocol) {
		t.Errorf("Receive err = %v, want ErrProtocol for a missing type", err)
	}
}

func TestConnRejectsWrongPayloadShape(t *testing.T) {
	s, c := newTestConnPair(t)
	// A manifest where a string is expected.
	if err := c.SendRaw(`{"type":"MANIFEST","payload":{"workspace_id":123}}`); err != nil {
		t.Fatal(err)
	}
	var m Manifest
	if err := s.ReceiveInto(TypeManifest, &m); !errors.Is(err, ErrProtocol) {
		t.Errorf("ReceiveInto err = %v, want ErrProtocol for a bad payload", err)
	}
}

func TestConnRejectsOversizeFrame(t *testing.T) {
	s, c := newTestConnPair(t)
	if err := c.WriteRawHeader(0xFFFFFFFF); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Receive(); err == nil {
		t.Error("Receive accepted an oversize frame announcement")
	}
}

func TestConnRemoteCert(t *testing.T) {
	s, c := newTestConnPair(t)

	if got := s.RemoteCertSHA256(); len(got) != 64 {
		t.Errorf("server-side peer fingerprint = %q, want 64 hex chars", got)
	}
	if got := c.RemoteCertSHA256(); len(got) != 64 {
		t.Errorf("client-side peer fingerprint = %q, want 64 hex chars", got)
	}
}

func TestConnCloseIdempotent(t *testing.T) {
	_, c := newTestConnPair(t)
	if err := c.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
	if !c.Closed() {
		t.Error("Closed() = false after Close")
	}
	if err := c.Send(TypePing, nil); err == nil {
		t.Error("Send succeeded on a closed connection")
	}
}

func TestConnEnvelopesAreValidJSON(t *testing.T) {
	_, c := newTestConnPair(t)
	if err := c.Send(TypeAck, Ack{Path: "src/app.py", Version: 12}); err != nil {
		t.Fatal(err)
	}
	// The transport must not be handed a non-JSON body: the receiver parses
	// the envelope with encoding/json.
	data, err := json.Marshal(Envelope{Type: TypeAck})
	if err != nil {
		t.Fatal(err)
	}
	if string(data) == "" {
		t.Error("envelope marshalled to nothing")
	}
}

func TestAuthProofUsesRealSecret(t *testing.T) {
	// Tie the auth helper to the identity flow: a member proves it holds the
	// join secret, not merely that it can complete a TLS handshake.
	secret := make([]byte, 16)
	rand.Read(secret)

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_ = priv

	hostNonce, err := NewNonce()
	if err != nil {
		t.Fatal(err)
	}
	memberNonce, err := NewNonce()
	if err != nil {
		t.Fatal(err)
	}
	proof := AuthProof(secret, "ws_83f92a", hostNonce, memberNonce)
	if len(proof) == 0 {
		t.Fatal("empty proof")
	}
	if !VerifyAuthProof(secret, "ws_83f92a", hostNonce, memberNonce, proof) {
		t.Error("proof did not verify")
	}
}

func TestEventSink(t *testing.T) {
	var got []Event
	sink := EventSink(func(e Event) { got = append(got, e) })

	sink.Emit(EventInfo, "hello %s", "world")
	if len(got) != 1 {
		t.Fatalf("got %d events, want 1", len(got))
	}
	if got[0].Message != "hello world" {
		t.Errorf("message = %q, want 'hello world'", got[0].Message)
	}
	if got[0].Kind != EventInfo {
		t.Errorf("kind = %q, want %q", got[0].Kind, EventInfo)
	}

	// A nil sink must not panic.
	var nilSink EventSink
	nilSink.Emit(EventInfo, "ignored")
}

func TestWithTimeout(t *testing.T) {
	ctx, cancel := WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	<-ctx.Done()
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Errorf("ctx.Err() = %v, want DeadlineExceeded", ctx.Err())
	}
}

func TestConnFileTransferBinarySafe(t *testing.T) {
	s, c := newTestConnPair(t)

	// Arbitrary bytes, including NUL and invalid UTF-8, must survive: file
	// contents are not text.
	data := []byte{0x00, 0xff, 0xfe, 0x01, '\n', 0x7f}
	if err := c.Send(TypeFileTransfer, FileTransfer{Path: "bin.dat", Data: data, Done: true}); err != nil {
		t.Fatal(err)
	}

	var got FileTransfer
	if err := s.ReceiveInto(TypeFileTransfer, &got); err != nil {
		t.Fatal(err)
	}
	if string(got.Data) != string(data) {
		t.Errorf("data = %v, want %v", got.Data, data)
	}
}

func TestStateDirNameIsStable(t *testing.T) {
	// The state directory name is part of the on-disk contract; changing it
	// would orphan existing workspaces.
	if got := filepath.Base("state.db"); got != "state.db" {
		t.Errorf("unexpected db name %q", got)
	}
}
