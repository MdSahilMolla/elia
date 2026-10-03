package security

import (
	"crypto/rand"
	"errors"
	"strings"
	"testing"
	"time"
)

func newTestPayload(t *testing.T) JoinCodePayload {
	t.Helper()
	fp := make([]byte, FingerprintSize)
	if _, err := rand.Read(fp); err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, SecretSize)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	return JoinCodePayload{
		Version:           1,
		WorkspaceID:       "ws_83f92a",
		Host:              "192.168.1.20",
		Port:              47821,
		ServerFingerprint: fp,
		Secret:            secret,
		ExpiresAt:         time.Now().UTC().Add(15 * time.Minute).Truncate(time.Second),
	}
}

func TestNewJoinCodeRoundTrip(t *testing.T) {
	fp := make([]byte, FingerprintSize)
	rand.Read(fp)

	code, payload, err := NewJoinCode("ws_83f92a", "10.0.0.5", 51234, fp, time.Hour)
	if err != nil {
		t.Fatalf("NewJoinCode: %v", err)
	}
	if len(payload.Secret) != SecretSize {
		t.Errorf("secret is %d bytes, want %d", len(payload.Secret), SecretSize)
	}

	parsed, err := ParseJoinCode(code)
	if err != nil {
		t.Fatalf("ParseJoinCode: %v", err)
	}
	if parsed.WorkspaceID != payload.WorkspaceID {
		t.Errorf("WorkspaceID = %q, want %q", parsed.WorkspaceID, payload.WorkspaceID)
	}
	if parsed.Host != payload.Host || parsed.Port != payload.Port {
		t.Errorf("address = %s:%d, want %s:%d", parsed.Host, parsed.Port, payload.Host, payload.Port)
	}
	if string(parsed.ServerFingerprint) != string(payload.ServerFingerprint) {
		t.Error("server fingerprint did not survive the round trip")
	}
	if string(parsed.Secret) != string(payload.Secret) {
		t.Error("secret did not survive the round trip")
	}
	if !parsed.ExpiresAt.Equal(payload.ExpiresAt) {
		t.Errorf("ExpiresAt = %v, want %v", parsed.ExpiresAt, payload.ExpiresAt)
	}
}

func TestParseJoinCodeAcceptsBothForms(t *testing.T) {
	p := newTestPayload(t)
	full := FormatJoinCode(p)

	url := FormatJoinCodeURL(p)
	grouped := FormatJoinCodeGrouped(p)

	for name, input := range map[string]string{"url": url, "grouped": grouped, "both": full} {
		t.Run(name, func(t *testing.T) {
			got, err := ParseJoinCode(input)
			if err != nil {
				t.Fatalf("ParseJoinCode: %v", err)
			}
			if got.WorkspaceID != p.WorkspaceID {
				t.Errorf("WorkspaceID = %q, want %q", got.WorkspaceID, p.WorkspaceID)
			}
		})
	}
}

// A code arrives by chat, email and terminal paste, so formatting noise is
// expected and must not be treated as a different code.
func TestParseJoinCodeNormalisesFormatting(t *testing.T) {
	p := newTestPayload(t)
	grouped := FormatJoinCodeGrouped(p)

	variants := map[string]string{
		"lowercase":      strings.ToLower(grouped),
		"no separators":  strings.ReplaceAll(grouped, "-", ""),
		"extra spaces":   strings.ReplaceAll(grouped, "-", " "),
		"surrounding ws": "  \n" + grouped + "\t ",
		"mixed case url": strings.ToLower(FormatJoinCodeURL(p)),
	}

	want, err := ParseJoinCode(grouped)
	if err != nil {
		t.Fatalf("baseline parse: %v", err)
	}

	for name, variant := range variants {
		t.Run(name, func(t *testing.T) {
			got, err := ParseJoinCode(variant)
			if err != nil {
				t.Fatalf("ParseJoinCode(%q): %v", name, err)
			}
			if got.WorkspaceID != want.WorkspaceID || string(got.Secret) != string(want.Secret) {
				t.Error("normalised parse produced a different code")
			}
		})
	}
}

func TestParseJoinCodeRejects(t *testing.T) {
	cases := map[string]string{
		"empty":            "",
		"whitespace":       "   ",
		"gibberish":        "not-a-real-code",
		"wrong scheme":     "https://join/ABCDE",
		"truncated":        FormatJoinCodeGrouped(newTestPayload(t))[:20],
		"trailing garbage": FormatJoinCodeGrouped(newTestPayload(t)) + "ZZZZZZZZZZ",
	}

	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseJoinCode(input); !errors.Is(err, ErrInvalidCode) {
				t.Errorf("ParseJoinCode(%q) err = %v, want ErrInvalidCode", name, err)
			}
		})
	}
}

func TestNewJoinCodeValidatesInput(t *testing.T) {
	fp := make([]byte, FingerprintSize)

	if _, _, err := NewJoinCode("bad-id", "host", 1234, fp, time.Hour); err == nil {
		t.Error("invalid workspace id accepted")
	}
	if _, _, err := NewJoinCode("ws_83f92a", "", 1234, fp, time.Hour); err == nil {
		t.Error("empty host accepted")
	}
	if _, _, err := NewJoinCode("ws_83f92a", "host", 0, fp, time.Hour); err == nil {
		t.Error("port 0 accepted")
	}
	if _, _, err := NewJoinCode("ws_83f92a", "host", 70000, fp, time.Hour); err == nil {
		t.Error("port 70000 accepted")
	}
	if _, _, err := NewJoinCode("ws_83f92a", "host", 1234, nil, time.Hour); err == nil {
		t.Error("missing fingerprint accepted")
	}
}

func TestJoinCodeSecretIsRandom(t *testing.T) {
	fp := make([]byte, FingerprintSize)
	seen := make(map[string]bool)
	for i := 0; i < 50; i++ {
		_, p, err := NewJoinCode("ws_83f92a", "host", 1234, fp, time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		k := string(p.Secret)
		if seen[k] {
			t.Fatalf("duplicate secret after %d draws", i)
		}
		seen[k] = true
	}
}

func TestHashCodeIsStableAndSensitive(t *testing.T) {
	p := newTestPayload(t)

	h1 := p.HashCode()
	if h2 := p.HashCode(); h1 != h2 {
		t.Error("HashCode is not deterministic")
	}
	if len(h1) != 64 {
		t.Errorf("HashCode length = %d, want 64 hex chars", len(h1))
	}

	// The host stores only this digest, so it must actually depend on the
	// secret: a code that differs only in secret must hash differently.
	q := p
	q.Secret = append([]byte(nil), p.Secret...)
	q.Secret[0] ^= 0xff
	if q.HashCode() == h1 {
		t.Error("HashCode ignores the secret")
	}
}

func TestExpired(t *testing.T) {
	p := newTestPayload(t)
	p.ExpiresAt = time.Now().UTC().Add(-time.Second)
	if !p.Expired(time.Now()) {
		t.Error("Expired = false for a past expiry")
	}

	p.ExpiresAt = time.Now().UTC().Add(time.Hour)
	if p.Expired(time.Now()) {
		t.Error("Expired = true for a future expiry")
	}
}

func TestAddress(t *testing.T) {
	p := newTestPayload(t)
	if got, want := p.Address(), "192.168.1.20:47821"; got != want {
		t.Errorf("Address = %q, want %q", got, want)
	}
}
