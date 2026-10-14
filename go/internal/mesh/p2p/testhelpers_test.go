package p2p

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"testing"
)

// mustPEM encodes an Ed25519 private key as PKCS#8 PEM.
func mustPEM(t *testing.T, key ed25519.PrivateKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}
