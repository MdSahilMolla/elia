package security

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// JoinCodePayload is the information a join code carries. Note what is *not*
// here: a long-lived credential. The secret authorises exactly one pairing.
type JoinCodePayload struct {
	// Version lets the format change without old codes parsing as valid.
	Version uint8
	// WorkspaceID identifies which workspace is being joined.
	WorkspaceID string
	// Host and Port address the listening peer.
	Host string
	Port int
	// ServerFingerprint is the 16-byte truncated SHA-256 of the host's
	// certificate public key. The joiner pins this, which is what makes the
	// handshake authenticated rather than trust-on-first-use.
	ServerFingerprint []byte
	// Secret authorises this pairing.
	Secret []byte
	// ExpiresAt bounds the code's lifetime, checked by the host.
	ExpiresAt time.Time
}

// SecretSize is the join secret length in bytes (128 bits).
const SecretSize = 16

// FingerprintSize is the truncated fingerprint length carried in a code.
const FingerprintSize = 16

// JoinCodeTTL is the default lifetime of a freshly minted code.
const JoinCodeTTL = 15 * time.Minute

// CodeURLScheme prefixes the shareable form of a join code.
const CodeURLScheme = "p2pws"

var codeEncoding = base32.NewEncoding("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567").WithPadding(base32.NoPadding)

// groupSize is the number of characters per display group. Grouping exists to
// catch transcription errors, not to make the code typable by voice.
const groupSize = 5

// ErrInvalidCode means the code could not be parsed at all.
var ErrInvalidCode = errors.New("invalid join code")

// NewJoinCode mints a fresh pairing code for a workspace.
func NewJoinCode(workspaceID, host string, port int, serverFingerprint []byte, ttl time.Duration) (string, JoinCodePayload, error) {
	if err := ValidateWorkspaceID(workspaceID); err != nil {
		return "", JoinCodePayload{}, err
	}
	if host == "" {
		return "", JoinCodePayload{}, errors.New("host must not be empty")
	}
	if port < 1 || port > 65535 {
		return "", JoinCodePayload{}, fmt.Errorf("port %d out of range", port)
	}
	if len(serverFingerprint) == 0 {
		return "", JoinCodePayload{}, errors.New("server fingerprint required")
	}
	if ttl <= 0 {
		ttl = JoinCodeTTL
	}

	secret := make([]byte, SecretSize)
	if _, err := rand.Read(secret); err != nil {
		return "", JoinCodePayload{}, fmt.Errorf("generate secret: %w", err)
	}

	p := JoinCodePayload{
		Version:           1,
		WorkspaceID:       workspaceID,
		Host:              host,
		Port:              port,
		ServerFingerprint: serverFingerprint,
		Secret:            secret,
		ExpiresAt:         time.Now().UTC().Add(ttl).Truncate(time.Second),
	}
	return FormatJoinCode(p), p, nil
}

// FormatJoinCode renders a payload in both supported forms.
func FormatJoinCode(p JoinCodePayload) string {
	return FormatJoinCodeURL(p) + "\n" + FormatJoinCodeGrouped(p)
}

// FormatJoinCodeURL renders the shareable p2pws:// form.
func FormatJoinCodeURL(p JoinCodePayload) string {
	return CodeURLScheme + "://join/" + encodePayload(p)
}

// FormatJoinCodeGrouped renders the bare payload in fixed-width groups.
func FormatJoinCodeGrouped(p JoinCodePayload) string {
	return group(encodePayload(p), groupSize)
}

// encodePayload serialises a payload to a length-prefixed binary layout and
// base32-encodes it. Each variable-length field carries its own length so the
// decoder can reject a malformed input without guessing.
func encodePayload(p JoinCodePayload) string {
	var b []byte
	b = append(b, p.Version)
	b = append(b, byte(len(p.WorkspaceID)))
	b = append(b, p.WorkspaceID...)

	host := p.Host
	if len(host) > 255 {
		host = host[:255]
	}
	b = append(b, byte(len(host)))
	b = append(b, host...)

	var portBytes [2]byte
	n := uint16(p.Port)
	portBytes[0] = byte(n >> 8)
	portBytes[1] = byte(n)
	b = append(b, portBytes[:]...)

	b = append(b, byte(len(p.ServerFingerprint)))
	b = append(b, p.ServerFingerprint...)

	b = append(b, byte(len(p.Secret)))
	b = append(b, p.Secret...)

	var exp [8]byte
	e := uint64(p.ExpiresAt.Unix())
	for i := 0; i < 8; i++ {
		exp[i] = byte(e >> (8 * (7 - i)))
	}
	b = append(b, exp[:]...)

	return codeEncoding.EncodeToString(b)
}

func decodePayload(s string) (JoinCodePayload, error) {
	raw, err := codeEncoding.DecodeString(s)
	if err != nil {
		return JoinCodePayload{}, fmt.Errorf("%w: %v", ErrInvalidCode, err)
	}
	r := &reader{b: raw}

	version, err := r.byte()
	if err != nil {
		return JoinCodePayload{}, err
	}
	if version != 1 {
		return JoinCodePayload{}, fmt.Errorf("%w: unsupported version %d", ErrInvalidCode, version)
	}

	wsID, err := r.string()
	if err != nil {
		return JoinCodePayload{}, err
	}
	host, err := r.string()
	if err != nil {
		return JoinCodePayload{}, err
	}
	portRaw, err := r.bytes(2)
	if err != nil {
		return JoinCodePayload{}, err
	}
	fp, err := r.counted()
	if err != nil {
		return JoinCodePayload{}, err
	}
	secret, err := r.counted()
	if err != nil {
		return JoinCodePayload{}, err
	}
	expRaw, err := r.bytes(8)
	if err != nil {
		return JoinCodePayload{}, err
	}
	if r.remaining() != 0 {
		return JoinCodePayload{}, fmt.Errorf("%w: %d trailing bytes", ErrInvalidCode, r.remaining())
	}

	var exp uint64
	for _, c := range expRaw {
		exp = exp<<8 | uint64(c)
	}

	return JoinCodePayload{
		Version:           version,
		WorkspaceID:       wsID,
		Host:              host,
		Port:              int(uint16(portRaw[0])<<8 | uint16(portRaw[1])),
		ServerFingerprint: fp,
		Secret:            secret,
		ExpiresAt:         time.Unix(int64(exp), 0).UTC(),
	}, nil
}

// ParseJoinCode accepts either the p2pws:// URL form or the bare grouped
// payload. Separators, case and surrounding whitespace are all normalised away,
// so a code pasted from a chat client still parses.
func ParseJoinCode(s string) (JoinCodePayload, error) {
	// `workspace create` prints the code as two lines (URL form, then grouped
	// form), and users copy whichever catches their eye, or the whole block.
	// Try each line in turn and accept the first that parses.
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) == 0 {
		return JoinCodePayload{}, fmt.Errorf("%w: empty input", ErrInvalidCode)
	}
	var firstErr error
	for _, line := range lines {
		p, err := parseJoinCodeLine(line)
		if err == nil {
			return p, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return JoinCodePayload{}, firstErr
}

func parseJoinCodeLine(s string) (JoinCodePayload, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return JoinCodePayload{}, fmt.Errorf("%w: empty input", ErrInvalidCode)
	}

	if u, err := url.Parse(s); err == nil && u.Scheme != "" {
		if u.Scheme != CodeURLScheme {
			return JoinCodePayload{}, fmt.Errorf("%w: unsupported scheme %q", ErrInvalidCode, u.Scheme)
		}
		if u.Host != "join" {
			return JoinCodePayload{}, fmt.Errorf("%w: unexpected host %q", ErrInvalidCode, u.Host)
		}
		s = u.Path
	}

	s = normalizeCode(s)
	if s == "" {
		return JoinCodePayload{}, fmt.Errorf("%w: no code payload found", ErrInvalidCode)
	}

	p, err := decodePayload(s)
	if err != nil {
		return JoinCodePayload{}, err
	}
	if err := p.Validate(); err != nil {
		return JoinCodePayload{}, fmt.Errorf("%w: %v", ErrInvalidCode, err)
	}
	return p, nil
}

// normalizeCode strips separators, uppercases and removes base32 padding, so
// "x7kp-92qm" and "X7KP92QM" are the same code.
func normalizeCode(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToUpper(s) {
		if (r >= 'A' && r <= 'Z') || (r >= '2' && r <= '7') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func group(s string, n int) string {
	if len(s) <= n {
		return s
	}
	var parts []string
	for i := 0; i < len(s); i += n {
		end := i + n
		if end > len(s) {
			end = len(s)
		}
		parts = append(parts, s[i:end])
	}
	return strings.Join(parts, "-")
}

// Validate checks the structural integrity of a decoded payload.
func (p JoinCodePayload) Validate() error {
	if err := ValidateWorkspaceID(p.WorkspaceID); err != nil {
		return err
	}
	if p.Host == "" {
		return errors.New("code has no host")
	}
	if p.Port < 1 || p.Port > 65535 {
		return fmt.Errorf("code port %d out of range", p.Port)
	}
	if len(p.ServerFingerprint) == 0 {
		return errors.New("code has no server fingerprint")
	}
	if len(p.Secret) != SecretSize {
		return fmt.Errorf("code secret is %d bytes, want %d", len(p.Secret), SecretSize)
	}
	if p.ExpiresAt.IsZero() {
		return errors.New("code has no expiry")
	}
	return nil
}

// Expired reports whether the code is past its stated lifetime. The host treats
// its own clock as authoritative; this is a client-side early rejection.
func (p JoinCodePayload) Expired(now time.Time) bool {
	return !now.UTC().Before(p.ExpiresAt)
}

// Address is the dial target for the hosting peer.
func (p JoinCodePayload) Address() string {
	return net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
}

// HashCode is the hex SHA-256 of the canonical encoded payload. This is what
// gets stored, so a leaked database does not hand out live join codes.
func (p JoinCodePayload) HashCode() string {
	sum := sha256.Sum256([]byte(encodePayload(p)))
	return hex.EncodeToString(sum[:])
}

// randomHex returns n random bytes hex-encoded, used for workspace and peer ids.
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// NewWorkspaceID mints a workspace identifier of the form ws_83f92a.
func NewWorkspaceID() (string, error) {
	suffix, err := randomHex(3)
	if err != nil {
		return "", err
	}
	return "ws_" + suffix, nil
}

// NewPeerID mints a peer identifier.
func NewPeerID() (string, error) {
	return randomHex(3)
}

// reader is a bounds-checked cursor over the decoded payload.
type reader struct {
	b []byte
	i int
}

func (r *reader) remaining() int { return len(r.b) - r.i }

func (r *reader) byte() (byte, error) {
	if r.remaining() < 1 {
		return 0, fmt.Errorf("%w: truncated payload", ErrInvalidCode)
	}
	v := r.b[r.i]
	r.i++
	return v, nil
}

func (r *reader) bytes(n int) ([]byte, error) {
	if n < 0 || r.remaining() < n {
		return nil, fmt.Errorf("%w: truncated payload", ErrInvalidCode)
	}
	v := r.b[r.i : r.i+n]
	r.i += n
	return v, nil
}

// counted reads a single length byte followed by that many bytes. It is the
// only safe way to read a variable-length field: the length is bounded to 255
// and the payload is bounds-checked against what is actually left.
func (r *reader) counted() ([]byte, error) {
	n, err := r.byte()
	if err != nil {
		return nil, err
	}
	return r.bytes(int(n))
}

func (r *reader) string() (string, error) {
	v, err := r.counted()
	if err != nil {
		return "", err
	}
	return string(v), nil
}
