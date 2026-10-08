package sync

import (
	"crypto/rand"
	"testing"
)

func TestAuthProofRoundTrip(t *testing.T) {
	secret := make([]byte, 16)
	rand.Read(secret)

	proof := AuthProof(secret, "ws_83f92a", "host-nonce", "member-nonce")
	if !VerifyAuthProof(secret, "ws_83f92a", "host-nonce", "member-nonce", proof) {
		t.Error("a correct proof failed verification")
	}
}

func TestAuthProofRejects(t *testing.T) {
	secret := make([]byte, 16)
	rand.Read(secret)
	other := make([]byte, 16)
	rand.Read(other)

	proof := AuthProof(secret, "ws_83f92a", "host-nonce", "member-nonce")

	cases := map[string]struct {
		secret, wsID, hostNonce, memberNonce string
	}{
		"wrong secret":    {string(other), "ws_83f92a", "host-nonce", "member-nonce"},
		"wrong workspace": {string(secret), "ws_000000", "host-nonce", "member-nonce"},
		"swapped nonces":  {string(secret), "ws_83f92a", "member-nonce", "host-nonce"},
		"replayed host":   {string(secret), "ws_83f92a", "host-nonce", "member-nonce-2"},
		"replayed member": {string(secret), "ws_83f92a", "host-nonce-2", "member-nonce"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if VerifyAuthProof([]byte(tc.secret), tc.wsID, tc.hostNonce, tc.memberNonce, proof) {
				t.Error("verification succeeded for a mismatched transcript")
			}
		})
	}
}

func TestAuthProofRejectsGarbage(t *testing.T) {
	secret := make([]byte, 16)
	rand.Read(secret)
	for _, bad := range []string{"", "x", "not base64 at all!!!"} {
		if VerifyAuthProof(secret, "ws_83f92a", "a", "b", bad) {
			t.Errorf("garbage proof %q was accepted", bad)
		}
	}
}

func TestNewNonce(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 32; i++ {
		n, err := NewNonce()
		if err != nil {
			t.Fatalf("NewNonce: %v", err)
		}
		if len(n) != 32 {
			t.Errorf("nonce length = %d, want 32 hex chars", len(n))
		}
		if seen[n] {
			t.Fatalf("duplicate nonce after %d draws", i)
		}
		seen[n] = true
	}
}

func TestHashBytes(t *testing.T) {
	// Known SHA-256 of the empty input.
	if got := HashBytes(nil); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Errorf("HashBytes(nil) = %s", got)
	}
	if HashBytes([]byte("a")) == HashBytes([]byte("b")) {
		t.Error("different inputs produced the same hash")
	}
}

func TestFileVersion(t *testing.T) {
	if got := FileVersion(12); got != "12" {
		t.Errorf("FileVersion(12) = %q, want 12", got)
	}
}
