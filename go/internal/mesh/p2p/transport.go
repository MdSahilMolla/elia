package p2p

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// ProtoName is the ALPN protocol identifier, so a stray non-workspace TLS
// client cannot interoperate by accident.
const ProtoName = "elia-go/internal/mesh/1"

// MaxFrameSize is the hard cap on one protocol frame. A peer announcing more
// than this is disconnected rather than allowed to make us allocate.
const MaxFrameSize = 8 << 20 // 8 MiB

// ErrFrameTooLarge means a peer sent a frame beyond MaxFrameSize.
var ErrFrameTooLarge = errors.New("frame exceeds maximum size")

// ErrFrameEmpty means a peer sent a zero-length frame.
var ErrFrameEmpty = errors.New("frame is empty")

// Listener accepts authenticated peer connections.
type Listener struct {
	ln   net.Listener
	cfg  *tls.Config
	addr net.Addr
}

// Listen starts a TLS listener presenting id's certificate. Client
// certificates are required but not chain-verified here; the caller decides
// which fingerprints to admit once the handshake completes.
func Listen(addr string, id *Identity) (*Listener, error) {
	cfg, err := id.TLSConfig()
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", addr, err)
	}
	return &Listener{ln: ln, cfg: cfg, addr: ln.Addr()}, nil
}

// Addr is the resolved bound address, useful when port 0 was requested.
func (l *Listener) Addr() net.Addr { return l.addr }

// Accept returns the next connection and the client certificate it presented.
func (l *Listener) Accept(ctx context.Context) (*Conn, *x509.Certificate, error) {
	type result struct {
		conn *tls.Conn
		err  error
	}
	ch := make(chan result, 1)

	go func() {
		// Handshakes happen on their own goroutine so that a peer which
		// connects and then goes silent cannot block Accept forever.
		raw, err := l.ln.Accept()
		if err != nil {
			ch <- result{err: err}
			return
		}
		tc := tls.Server(raw, l.cfg)
		if err := tc.HandshakeContext(ctx); err != nil {
			tc.Close()
			ch <- result{err: fmt.Errorf("tls handshake: %w", err)}
			return
		}
		ch <- result{conn: tc}
	}()

	select {
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	case r := <-ch:
		if r.err != nil {
			return nil, nil, r.err
		}
		leaf, err := CertFromConn(r.conn)
		if err != nil {
			r.conn.Close()
			return nil, nil, err
		}
		c := NewConn(r.conn)
		c.remoteCert.Store(&tls.Certificate{Leaf: leaf, Certificate: [][]byte{leaf.Raw}})
		return c, leaf, nil
	}
}

// DialShortPin connects to a peer using a truncated fingerprint pin, as carried
// inside a join code. Only the leading len(pin) bytes of the fingerprint are
// compared.
func DialShortPin(ctx context.Context, address string, id *Identity, shortPin []byte) (*Conn, error) {
	cfg, err := ClientTLSConfigShortPin(id, shortPin)
	if err != nil {
		return nil, err
	}
	return dialWithConfig(ctx, address, cfg)
}

// DialPinned connects to a peer, accepting either a full 32-byte fingerprint
// or the truncated pin carried in a join code. The length decides which
// comparison applies, so a caller holding either kind of pin can use this.
func DialPinned(ctx context.Context, address string, id *Identity, pin []byte) (*Conn, error) {
	switch len(pin) {
	case sha256.Size:
		return Dial(ctx, address, id, pin)
	case FingerprintLen:
		return DialShortPin(ctx, address, id, pin)
	default:
		return nil, fmt.Errorf("pin must be %d or %d bytes, got %d", sha256.Size, FingerprintLen, len(pin))
	}
}

// Close stops accepting new connections.
func (l *Listener) Close() error { return l.ln.Close() }

// Dial connects to a peer, presenting id and pinning the server's certificate
// to wantFingerprint, which must be the full 32-byte fingerprint.
func Dial(ctx context.Context, address string, id *Identity, wantFingerprint []byte) (*Conn, error) {
	cfg, err := ClientTLSConfig(id, wantFingerprint)
	if err != nil {
		return nil, err
	}
	return dialWithConfig(ctx, address, cfg)
}

func dialWithConfig(ctx context.Context, address string, cfg *tls.Config) (*Conn, error) {
	d := &net.Dialer{Timeout: 15 * time.Second}
	raw, err := d.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", address, err)
	}
	tc := tls.Client(raw, cfg)
	if err := tc.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, fmt.Errorf("tls handshake with %s: %w", address, err)
	}

	c := NewConn(tc)
	// Capture the verified server certificate. The dialling side needs it to
	// record the host's fingerprint for later reconnects, where no join code
	// will be presented.
	leaf, err := CertFromConn(tc)
	if err != nil {
		tc.Close()
		return nil, err
	}
	c.remoteCert.Store(&tls.Certificate{Leaf: leaf, Certificate: [][]byte{leaf.Raw}})
	return c, nil
}

// Conn is a framed, bidirectional message channel over one authenticated
// connection. Writes are serialised by a mutex; reads happen on a single
// goroutine.
type Conn struct {
	raw    net.Conn
	r      *bufio.Reader
	wmu    sync.Mutex
	w      *bufio.Writer
	closed atomic.Bool

	remoteCert atomic.Pointer[tls.Certificate]
}

// NewConn wraps an established connection.
func NewConn(raw net.Conn) *Conn {
	return &Conn{
		raw: raw,
		r:   bufio.NewReaderSize(raw, 64<<10),
		w:   bufio.NewWriterSize(raw, 64<<10),
	}
}

// RemoteAddr is the peer's address.
func (c *Conn) RemoteAddr() net.Addr { return c.raw.RemoteAddr() }

// RemoteCert is the peer certificate captured when the connection was
// established, or nil if the connection was not created by Listen.
func (c *Conn) RemoteCert() *x509.Certificate {
	if p := c.remoteCert.Load(); p != nil {
		return p.Leaf
	}
	return nil
}

// WriteFrame sends one length-prefixed payload.
func (c *Conn) WriteFrame(payload []byte) error {
	if c.closed.Load() {
		return net.ErrClosed
	}
	if len(payload) == 0 {
		return ErrFrameEmpty
	}
	if int64(len(payload)) > MaxFrameSize {
		return fmt.Errorf("%w: %d bytes", ErrFrameTooLarge, len(payload))
	}

	c.wmu.Lock()
	defer c.wmu.Unlock()

	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload)))
	if _, err := c.w.Write(hdr[:]); err != nil {
		return fmt.Errorf("write frame header: %w", err)
	}
	if _, err := c.w.Write(payload); err != nil {
		return fmt.Errorf("write frame body: %w", err)
	}
	if err := c.w.Flush(); err != nil {
		return fmt.Errorf("flush frame: %w", err)
	}
	return nil
}

// ReadFrame receives one length-prefixed payload. The announced length is
// checked against MaxFrameSize *before* allocating, so a hostile peer cannot
// induce a large allocation with a four-byte header.
func (c *Conn) ReadFrame() ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(c.r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 {
		return nil, ErrFrameEmpty
	}
	if int64(n) > MaxFrameSize {
		return nil, fmt.Errorf("%w: peer announced %d bytes", ErrFrameTooLarge, n)
	}

	buf := make([]byte, n)
	if _, err := io.ReadFull(c.r, buf); err != nil {
		return nil, fmt.Errorf("read frame body: %w", err)
	}
	return buf, nil
}

// WriteUnvalidatedHeader writes a length prefix without checking it against
// MaxFrameSize. It exists so tests can simulate a peer announcing a hostile
// frame size; production code must use WriteFrame.
func (c *Conn) WriteUnvalidatedHeader(n uint32) error {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], n)
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if _, err := c.w.Write(hdr[:]); err != nil {
		return err
	}
	return c.w.Flush()
}

// Close shuts the connection down. Safe to call more than once.
func (c *Conn) Close() error {
	if c.closed.Swap(true) {
		return nil
	}
	return c.raw.Close()
}

// SetDeadline bounds all future reads and writes.
func (c *Conn) SetDeadline(t time.Time) error { return c.raw.SetDeadline(t) }

// SetReadDeadline bounds future reads.
func (c *Conn) SetReadDeadline(t time.Time) error { return c.raw.SetReadDeadline(t) }
