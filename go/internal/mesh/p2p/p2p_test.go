package p2p

import (
	"bytes"
	"context"
	"crypto/tls"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTestIdentity(t *testing.T) *Identity {
	t.Helper()
	id, err := CreateIdentity(t.TempDir(), "a1b2c3")
	if err != nil {
		t.Fatalf("CreateIdentity: %v", err)
	}
	return id
}

func TestCreateIdentity(t *testing.T) {
	id := newTestIdentity(t)

	if id.Cert == nil || id.Cert.SerialNumber == nil {
		t.Fatal("identity has no usable certificate")
	}
	if id.Cert.PublicKeyAlgorithm != 4 { // ed25519
		t.Errorf("PublicKeyAlgorithm = %v, want ed25519", id.Cert.PublicKeyAlgorithm)
	}
	if !id.Cert.NotAfter.After(time.Now()) {
		t.Error("certificate is already expired")
	}
	if len(id.ShortFingerprint()) != FingerprintLen {
		t.Errorf("ShortFingerprint length = %d, want %d", len(id.ShortFingerprint()), FingerprintLen)
	}
	if len(id.Fingerprint()) != 32 {
		t.Errorf("Fingerprint length = %d, want 32", len(id.Fingerprint()))
	}
	if !bytes.HasPrefix(id.Fingerprint(), id.ShortFingerprint()) {
		t.Error("short fingerprint is not a prefix of the full fingerprint")
	}
}

func TestIdentityKeyPermissions(t *testing.T) {
	dir := t.TempDir()
	id, err := CreateIdentity(dir, "a1b2c3")
	if err != nil {
		t.Fatalf("CreateIdentity: %v", err)
	}

	info, err := os.Stat(id.KeyPath)
	if err != nil {
		t.Fatalf("stat key: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("key permissions = %o, want 600", perm)
	}
}

func TestLoadOrCreateIdentityReuses(t *testing.T) {
	dir := t.TempDir()

	first, err := LoadOrCreateIdentity(dir, "a1b2c3")
	if err != nil {
		t.Fatalf("first LoadOrCreateIdentity: %v", err)
	}
	second, err := LoadOrCreateIdentity(dir, "a1b2c3")
	if err != nil {
		t.Fatalf("second LoadOrCreateIdentity: %v", err)
	}

	// Reuse is the point: rotating identity on restart would invalidate
	// outstanding join codes and break pinning.
	if !bytes.Equal(first.Fingerprint(), second.Fingerprint()) {
		t.Error("identity changed between loads")
	}
	if second.PeerID != "a1b2c3" {
		t.Errorf("PeerID = %q, want a1b2c3", second.PeerID)
	}
}

func TestLoadIdentityRejectsMismatchedPair(t *testing.T) {
	dir := t.TempDir()
	a, err := CreateIdentity(dir, "a1b2c3")
	if err != nil {
		t.Fatal(err)
	}
	b := newTestIdentity(t)

	// Key from one identity, certificate from another.
	if err := os.WriteFile(a.KeyPath, mustPEM(t, b.Key), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadIdentity(a.KeyPath, a.CertPath); err == nil {
		t.Error("mismatched key and certificate were accepted")
	}
}

func TestLoadIdentityMissing(t *testing.T) {
	_, err := loadIdentity(filepath.Join(t.TempDir(), "nokey"), filepath.Join(t.TempDir(), "nocert"))
	if err == nil {
		t.Error("expected an error for a missing identity")
	}
}

func TestFingerprintPinRoundTrip(t *testing.T) {
	id := newTestIdentity(t)

	if err := VerifyPinnedCert([][]byte{id.CertDER}, id.Fingerprint()); err != nil {
		t.Errorf("VerifyPinnedCert with the correct pin: %v", err)
	}
	if err := VerifyPinnedCert([][]byte{id.CertDER}, newTestIdentity(t).Fingerprint()); err == nil {
		t.Error("VerifyPinnedCert accepted the wrong certificate")
	}
	if err := VerifyPinnedCert(nil, id.Fingerprint()); err == nil {
		t.Error("VerifyPinnedCert accepted an empty chain")
	}
	if err := VerifyPinnedCert([][]byte{{0x01, 0x02}}, id.Fingerprint()); err == nil {
		t.Error("VerifyPinnedCert accepted garbage DER")
	}
}

func TestClientTLSConfigRequiresPin(t *testing.T) {
	if _, err := ClientTLSConfig(newTestIdentity(t), nil); err == nil {
		t.Error("ClientTLSConfig accepted a nil pin")
	}
}

// End-to-end: a real TLS handshake between two identities, with the client
// pinning the server.
func TestListenDialHandshake(t *testing.T) {
	server := newTestIdentity(t)
	client := newTestIdentity(t)

	ln, err := Listen("127.0.0.1:0", server)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()

	acceptCh := make(chan *Conn, 1)
	errCh := make(chan error, 1)
	go func() {
		c, cert, err := ln.Accept(context.Background())
		if err != nil {
			errCh <- err
			return
		}
		if got, want := CertFingerprintHex(cert), client.FingerprintHex(); got != want {
			t.Errorf("server saw client cert %s, want %s", got, want)
		}
		acceptCh <- c
	}()

	cctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, err := Dial(cctx, ln.Addr().String(), client, server.Fingerprint())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	select {
	case err := <-errCh:
		t.Fatalf("Accept: %v", err)
	case sc := <-acceptCh:
		defer sc.Close()
		if got, want := CertFingerprintHex(sc.RemoteCert()), client.FingerprintHex(); got != want {
			t.Errorf("client presented cert %s, want %s", got, want)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for the server to accept")
	}
}

// The pin must actually reject a server whose key does not match, otherwise the
// self-signed certificate buys nothing.
func TestDialRejectsWrongFingerprint(t *testing.T) {
	server := newTestIdentity(t)
	client := newTestIdentity(t)
	impostor := newTestIdentity(t)

	ln, err := Listen("127.0.0.1:0", server)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()

	go func() {
		c, _, err := ln.Accept(context.Background())
		if err == nil {
			c.Close()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, err := Dial(ctx, ln.Addr().String(), client, impostor.Fingerprint())
	if err == nil {
		conn.Close()
		t.Fatal("Dial succeeded against a mismatched fingerprint")
	}
}

func TestDialPlaintextClientRejected(t *testing.T) {
	server := newTestIdentity(t)
	ln, err := Listen("127.0.0.1:0", server)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()

	accepted := make(chan struct{}, 1)
	go func() {
		if _, _, err := ln.Accept(context.Background()); err == nil {
			accepted <- struct{}{}
		}
	}()

	raw, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("plain dial: %v", err)
	}
	// No TLS client hello at all.
	raw.Write([]byte("GET / HTTP/1.1\r\n\r\n"))
	raw.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 1)
	if _, err := raw.Read(buf); err == nil {
		// The server should not speak HTTP, nor complete a handshake.
		t.Errorf("plaintext exchange returned data: %q", buf[:1])
	}
	raw.Close()
}

func TestFrameRoundTrip(t *testing.T) {
	server, client := newTestIdentity(t), newTestIdentity(t)

	sc, cc := pipePair(t, server, client)
	defer sc.Close()
	defer cc.Close()

	payload := []byte(`{"type":"PING"}`)
	if err := cc.WriteFrame(payload); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}
	got, err := sc.ReadFrame()
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("ReadFrame = %q, want %q", got, payload)
	}
}

func TestWriteFrameRejectsBadSizes(t *testing.T) {
	server, client := newTestIdentity(t), newTestIdentity(t)
	sc, cc := pipePair(t, server, client)
	defer sc.Close()
	defer cc.Close()

	if err := cc.WriteFrame(nil); err != ErrFrameEmpty {
		t.Errorf("WriteFrame(nil) = %v, want ErrFrameEmpty", err)
	}
	if err := cc.WriteFrame(make([]byte, MaxFrameSize+1)); err == nil {
		t.Error("WriteFrame above the cap was accepted")
	}
}

// A peer must not be able to induce a large allocation by announcing a huge
// length in a four-byte header.
func TestReadFrameRejectsOversizeHeader(t *testing.T) {
	server, client := newTestIdentity(t), newTestIdentity(t)
	sc, cc := pipePair(t, server, client)
	defer sc.Close()
	defer cc.Close()

	// Announce 4 GiB, send nothing.
	if err := cc.WriteUnvalidatedHeader(0xFFFFFFFF); err != nil {
		t.Fatalf("WriteRawHeader: %v", err)
	}
	if _, err := sc.ReadFrame(); err == nil {
		t.Error("ReadFrame accepted a 4 GiB announced length")
	}
}

func TestReadFrameRejectsEmptyHeader(t *testing.T) {
	server, client := newTestIdentity(t), newTestIdentity(t)
	sc, cc := pipePair(t, server, client)
	defer sc.Close()
	defer cc.Close()

	if err := cc.WriteUnvalidatedHeader(0); err != nil {
		t.Fatalf("WriteRawHeader: %v", err)
	}
	if _, err := sc.ReadFrame(); err != ErrFrameEmpty {
		t.Errorf("ReadFrame = %v, want ErrFrameEmpty", err)
	}
}

func TestConnCloseIsIdempotent(t *testing.T) {
	server, client := newTestIdentity(t), newTestIdentity(t)
	sc, cc := pipePair(t, server, client)
	defer sc.Close()

	if err := cc.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := cc.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
	if err := cc.WriteFrame([]byte("x")); err == nil {
		t.Error("WriteFrame succeeded on a closed connection")
	}
}

func TestTLSVersionIs13(t *testing.T) {
	server := newTestIdentity(t)
	cfg, err := server.TLSConfig()
	if err != nil {
		t.Fatalf("TLSConfig: %v", err)
	}
	if cfg.MinVersion != tls.VersionTLS13 {
		t.Errorf("MinVersion = %x, want TLS 1.3", cfg.MinVersion)
	}
	if cfg.ClientAuth != tls.RequireAnyClientCert {
		t.Errorf("ClientAuth = %v, want RequireAnyClientCert", cfg.ClientAuth)
	}

	ccfg, err := ClientTLSConfig(newTestIdentity(t), server.Fingerprint())
	if err != nil {
		t.Fatal(err)
	}
	if ccfg.MinVersion != tls.VersionTLS13 {
		t.Errorf("client MinVersion = %x, want TLS 1.3", ccfg.MinVersion)
	}
}

// pipePair returns a connected client/server Conn pair over a real TLS session.
func pipePair(t *testing.T, server, client *Identity) (serverConn, clientConn *Conn) {
	t.Helper()

	ln, err := Listen("127.0.0.1:0", server)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	type result struct {
		c   *Conn
		err error
	}
	ch := make(chan result, 1)
	go func() {
		c, _, err := ln.Accept(context.Background())
		ch <- result{c, err}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cc, err := Dial(ctx, ln.Addr().String(), client, server.Fingerprint())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	r := <-ch
	if r.err != nil {
		t.Fatalf("Accept: %v", r.err)
	}
	return r.c, cc
}
