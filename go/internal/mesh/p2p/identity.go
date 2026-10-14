// Package p2p provides peer identity, authenticated TLS transport and
// length-prefixed framing. It is deliberately independent of the sync engine:
// nothing here knows what a patch or a manifest is.
package p2p

import (
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// IdentityFileName holds the peer's private key and certificate inside the
// workspace state directory.
const (
	IdentityFileName = "identity.key"
	CertFileName     = "identity.crt"
)

// FingerprintLen is the truncated SHA-256 length carried inside a join code.
const FingerprintLen = 16

// certValidity is how long a generated certificate remains valid.
const certValidity = 365 * 24 * time.Hour

// Identity is a peer's long-lived key material. It is created once per
// workspace and reused, so a workspace does not silently rotate identity every
// time `serve` restarts.
type Identity struct {
	Cert     *x509.Certificate
	CertPEM  []byte
	CertDER  []byte
	Key      ed25519.PrivateKey
	PeerID   string
	KeyPath  string
	CertPath string
}

// ErrNoIdentity means no identity exists yet at the given location.
var ErrNoIdentity = errors.New("no peer identity found")

// LoadOrCreateIdentity returns the identity stored under dir, generating it on
// first use. dir is normally <root>/.workspace.
func LoadOrCreateIdentity(dir, peerID string) (*Identity, error) {
	keyPath := filepath.Join(dir, IdentityFileName)
	certPath := filepath.Join(dir, CertFileName)

	id, err := loadIdentity(keyPath, certPath)
	if err == nil {
		id.PeerID = peerID
		return id, nil
	}
	if !errors.Is(err, ErrNoIdentity) {
		return nil, err
	}
	return CreateIdentity(dir, peerID)
}

func loadIdentity(keyPath, certPath string) (*Identity, error) {
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNoIdentity
		}
		return nil, fmt.Errorf("read identity key: %w", err)
	}
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNoIdentity
		}
		return nil, fmt.Errorf("read identity cert: %w", err)
	}

	key, err := parsePrivateKey(keyPEM)
	if err != nil {
		return nil, err
	}
	cert, err := parseCertificate(certPEM)
	if err != nil {
		return nil, err
	}

	// A key and cert that do not belong together would silently break pinning
	// in a confusing way later, so refuse to load them.
	if !publicKeysEqual(cert.PublicKey, key.Public()) {
		return nil, errors.New("identity key does not match identity certificate")
	}

	return &Identity{
		Cert:     cert,
		CertPEM:  certPEM,
		CertDER:  cert.Raw,
		Key:      key,
		KeyPath:  keyPath,
		CertPath: certPath,
	}, nil
}

// CreateIdentity generates a fresh Ed25519 identity and writes it to disk.
func CreateIdentity(dir, peerID string) (*Identity, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create identity dir: %w", err)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate ed25519 key: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("generate serial: %w", err)
	}

	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		// A minute of backdating absorbs clock skew between peers without
		// meaningfully widening the validity window.
		NotBefore: now.Add(-time.Minute),
		NotAfter:  now.Add(certValidity),
		Subject:   pkix.Name{CommonName: peerID},
		// Self-signed: this certificate is its own authority. Peers pin it by
		// fingerprint rather than chaining to a CA.
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		// Both roles are listed because any peer may later dial out to another
		// member rather than only accepting inbound connections.
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:    []string{"localhost"},
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, pub, priv)
	if err != nil {
		return nil, fmt.Errorf("create certificate: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("parse generated certificate: %w", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("marshal private key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})

	keyPath := filepath.Join(dir, IdentityFileName)
	certPath := filepath.Join(dir, CertFileName)
	if err := writeFileAtomic(keyPath, keyPEM, 0o600); err != nil {
		return nil, err
	}
	if err := writeFileAtomic(certPath, certPEM, 0o644); err != nil {
		return nil, err
	}

	return &Identity{
		Cert:     cert,
		CertPEM:  certPEM,
		CertDER:  der,
		Key:      priv,
		PeerID:   peerID,
		KeyPath:  keyPath,
		CertPath: certPath,
	}, nil
}

// Fingerprint returns the full SHA-256 of the certificate's public key. This is
// the value peers pin: it identifies the key, so it survives certificate
// renewal with the same key.
func (id *Identity) Fingerprint() []byte {
	sum := sha256.Sum256(id.Cert.RawSubjectPublicKeyInfo)
	return sum[:]
}

// FingerprintHex is the hex-encoded full fingerprint, stored in the peers table.
func (id *Identity) FingerprintHex() string {
	return hex.EncodeToString(id.Fingerprint())
}

// ShortFingerprint is the truncated form that travels inside a join code.
func (id *Identity) ShortFingerprint() []byte {
	fp := id.Fingerprint()
	if len(fp) < FingerprintLen {
		return fp
	}
	return fp[:FingerprintLen]
}

// ShortFingerprintHex is the hex-encoded truncated fingerprint.
func (id *Identity) ShortFingerprintHex() string {
	return hex.EncodeToString(id.ShortFingerprint())
}

// TLSConfig returns the server-side TLS configuration: TLS 1.3 minimum,
// requiring a client certificate. It does not verify the client against a CA,
// because the real check is the caller's fingerprint pin, applied after the
// handshake.
func (id *Identity) TLSConfig() (*tls.Config, error) {
	cert, err := id.selfSignedTLSCertificate()
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		ClientAuth:   tls.RequireAnyClientCert,
		NextProtos:   []string{ProtoName},
	}, nil
}

func (id *Identity) selfSignedTLSCertificate() (tls.Certificate, error) {
	cert, err := tls.X509KeyPair(id.CertPEM, pemEncodeKey(id.Key))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("build tls certificate: %w", err)
	}
	cert.Leaf = id.Cert
	return cert, nil
}

// FingerprintOfCert computes the full fingerprint of a peer's certificate, for
// pinning after a handshake.
func FingerprintOfCert(cert *x509.Certificate) []byte {
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return sum[:]
}

// CertFingerprintHex renders a certificate fingerprint for storage.
func CertFingerprintHex(cert *x509.Certificate) string {
	return hex.EncodeToString(FingerprintOfCert(cert))
}

// ClientTLSConfig builds the dialling side of an authenticated connection. The
// host's certificate is self-signed, so the normal chain verification cannot
// succeed; instead the caller supplies the exact fingerprint to pin, taken from
// the join code. Verification is disabled *only* because it is replaced
// immediately by this stricter check.
func ClientTLSConfig(id *Identity, pinFullFingerprint []byte) (*tls.Config, error) {
	if len(pinFullFingerprint) == 0 {
		return nil, errors.New("a server fingerprint pin is required")
	}
	cert, err := id.selfSignedTLSCertificate()
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates:       []tls.Certificate{cert},
		MinVersion:         tls.VersionTLS13,
		InsecureSkipVerify: true,
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			return VerifyPinnedCert(rawCerts, pinFullFingerprint)
		},
		NextProtos: []string{ProtoName},
	}, nil
}

// ClientTLSConfigShortPin is ClientTLSConfig for a join code, which carries a
// truncated fingerprint to keep the code shorter. The comparison is made
// against the same truncated length, so a 16-byte pin means 128 bits of the
// SHA-256 are checked, not all 256.
func ClientTLSConfigShortPin(id *Identity, shortPin []byte) (*tls.Config, error) {
	if len(shortPin) == 0 {
		return nil, errors.New("a server fingerprint pin is required")
	}
	cert, err := id.selfSignedTLSCertificate()
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates:       []tls.Certificate{cert},
		MinVersion:         tls.VersionTLS13,
		InsecureSkipVerify: true,
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			return VerifyPinnedCertShort(rawCerts, shortPin)
		},
		NextProtos: []string{ProtoName},
	}, nil
}

// VerifyPinnedCert checks that the server presented a certificate whose public
// key matches the pin. Comparing the SPKI hash rather than the whole DER means
// a renewed certificate with the same key still matches.
func VerifyPinnedCert(rawCerts [][]byte, pin []byte) error {
	return verifyPin(rawCerts, pin, false)
}

// VerifyPinnedCertShort compares only the leading len(pin) bytes of the
// fingerprint, matching what a truncated join-code pin can actually assert.
func VerifyPinnedCertShort(rawCerts [][]byte, pin []byte) error {
	return verifyPin(rawCerts, pin, true)
}

func verifyPin(rawCerts [][]byte, pin []byte, truncated bool) error {
	if len(rawCerts) == 0 {
		return errors.New("peer presented no certificate")
	}
	leaf, err := x509.ParseCertificate(rawCerts[0])
	if err != nil {
		return fmt.Errorf("parse peer certificate: %w", err)
	}
	got := FingerprintOfCert(leaf)
	cmp, cmpPin := got, pin
	if truncated {
		n := len(pin)
		if len(got) < n {
			return fmt.Errorf("fingerprint is shorter than the %d-byte pin", n)
		}
		cmp, cmpPin = got[:n], pin
	}
	if !equalBytes(cmp, cmpPin) {
		return fmt.Errorf("server certificate fingerprint mismatch: got %s, expected %s",
			hex.EncodeToString(cmp), hex.EncodeToString(cmpPin))
	}
	return nil
}

// CertFromConn extracts the verified peer certificate from an established
// connection.
func CertFromConn(c *tls.Conn) (*x509.Certificate, error) {
	state := c.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		return nil, errors.New("peer presented no certificate")
	}
	return state.PeerCertificates[0], nil
}

func parsePrivateKey(pemBytes []byte) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("identity key is not valid PEM")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse identity key: %w", err)
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("identity key is %T, want ed25519.PrivateKey", key)
	}
	return priv, nil
}

func parseCertificate(pemBytes []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("identity certificate is not valid PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse identity certificate: %w", err)
	}
	return cert, nil
}

func pemEncodeKey(priv ed25519.PrivateKey) []byte {
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		// MarshalPKCS8PrivateKey only fails for unsupported key types, and
		// ed25519 is always supported.
		panic("p2p: marshal ed25519 key: " + err.Error())
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

func publicKeysEqual(a, b any) bool {
	type equaler interface{ Equal(x crypto.PublicKey) bool }
	ae, aok := a.(equaler)
	be, bok := b.(equaler)
	if !aok || !bok {
		return false
	}
	return ae.Equal(be)
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// writeFileAtomic writes via a temp file and rename so a crash cannot leave a
// half-written identity behind.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename temp file: %w", err)
	}
	return nil
}
