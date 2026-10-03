package sync

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
)

// Transcript builds the canonical string both peers HMAC when authenticating.
// Including both nonces and the workspace id prevents replay across sessions
// and across workspaces.
func Transcript(workspaceID, hostNonce, memberNonce string) []byte {
	return []byte("elia-go/internal/mesh/auth/v1\n" + workspaceID + "\n" + hostNonce + "\n" + memberNonce + "\n")
}

// AuthProof computes the HMAC-SHA256 over the transcript, keyed by the join
// secret. This is what proves the joiner actually holds the code.
func AuthProof(secret []byte, workspaceID, hostNonce, memberNonce string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(Transcript(workspaceID, hostNonce, memberNonce))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// VerifyAuthProof recomputes and compares in constant time.
func VerifyAuthProof(secret []byte, workspaceID, hostNonce, memberNonce, got string) bool {
	want := AuthProof(secret, workspaceID, hostNonce, memberNonce)
	return hmac.Equal([]byte(want), []byte(got))
}

// NewNonce returns a random hex nonce for the handshake.
func NewNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// HashBytes returns the hex SHA-256 of a payload, the form stored in manifests.
func HashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// FileVersion renders a version for display and logging.
func FileVersion(v int64) string { return strconv.FormatInt(v, 10) }
