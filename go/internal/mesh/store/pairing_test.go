package store

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestCodeLifecycle(t *testing.T) {
	s := newTestStore(t)

	rec, err := s.AddCode("hash1", time.Now().Add(15*time.Minute), 1)
	if err != nil {
		t.Fatalf("AddCode: %v", err)
	}
	if rec.Uses != 0 || rec.MaxUses != 1 {
		t.Errorf("new code = %+v, want uses 0 max 1", rec)
	}

	got, err := s.CodeByHash("hash1")
	if err != nil {
		t.Fatalf("CodeByHash: %v", err)
	}
	if got.ID != rec.ID {
		t.Errorf("ID = %d, want %d", got.ID, rec.ID)
	}

	if _, err := s.CodeByHash("missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("CodeByHash(missing) err = %v, want ErrNotFound", err)
	}
}

func TestAddCodeRejectsZeroUses(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.AddCode("h", time.Now().Add(time.Minute), 0); err == nil {
		t.Error("AddCode(maxUses=0) returned nil error, want failure")
	}
}

func TestRedeemSingleUse(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.AddCode("hash1", time.Now().Add(15*time.Minute), 1); err != nil {
		t.Fatalf("AddCode: %v", err)
	}

	if _, err := s.RedeemCode("hash1", time.Now()); err != nil {
		t.Fatalf("first RedeemCode: %v", err)
	}
	if _, err := s.RedeemCode("hash1", time.Now()); !errors.Is(err, ErrCodeExhausted) {
		t.Errorf("second RedeemCode err = %v, want ErrCodeExhausted", err)
	}
	if _, err := s.RedeemCode("nosuch", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Errorf("RedeemCode(unknown) err = %v, want ErrNotFound", err)
	}
}

func TestRedeemRejectsExpired(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.AddCode("hash1", time.Now().Add(-time.Second), 5); err != nil {
		t.Fatalf("AddCode: %v", err)
	}
	if _, err := s.RedeemCode("hash1", time.Now()); !errors.Is(err, ErrCodeExpired) {
		t.Errorf("RedeemCode err = %v, want ErrCodeExpired", err)
	}
}

func TestRedeemRespectsMaxUses(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.AddCode("hash1", time.Now().Add(time.Hour), 3); err != nil {
		t.Fatalf("AddCode: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := s.RedeemCode("hash1", time.Now()); err != nil {
			t.Fatalf("RedeemCode #%d: %v", i+1, err)
		}
	}
	if _, err := s.RedeemCode("hash1", time.Now()); !errors.Is(err, ErrCodeExhausted) {
		t.Errorf("4th RedeemCode err = %v, want ErrCodeExhausted", err)
	}
}

// A single-use code is the interesting race: two peers pasting the same code at
// the same moment must not both get in. The conditional UPDATE in RedeemCode is
// what makes this safe, so assert it rather than trusting the reasoning.
func TestRedeemSingleUseIsRaceSafe(t *testing.T) {
	const attempts = 24
	s := newTestStore(t)
	if _, err := s.AddCode("hash1", time.Now().Add(time.Hour), 1); err != nil {
		t.Fatalf("AddCode: %v", err)
	}

	var (
		wg        sync.WaitGroup
		mu        sync.Mutex
		succeeded int
		failures  []error
	)
	now := time.Now()
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.RedeemCode("hash1", now); err != nil {
				mu.Lock()
				failures = append(failures, err)
				mu.Unlock()
				return
			}
			mu.Lock()
			succeeded++
			mu.Unlock()
		}()
	}
	wg.Wait()

	if succeeded != 1 {
		t.Errorf("%d concurrent redemptions succeeded, want exactly 1", succeeded)
	}
	for _, err := range failures {
		if !errors.Is(err, ErrCodeExhausted) {
			t.Errorf("unexpected failure: %v", err)
		}
	}

	rec, err := s.CodeByHash("hash1")
	if err != nil {
		t.Fatalf("CodeByHash: %v", err)
	}
	if rec.Uses != 1 {
		t.Errorf("recorded uses = %d, want 1", rec.Uses)
	}
}

func TestExpireCodes(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.AddCode("old", time.Now().Add(-time.Hour), 1); err != nil {
		t.Fatalf("AddCode old: %v", err)
	}
	if _, err := s.AddCode("live", time.Now().Add(time.Hour), 1); err != nil {
		t.Fatalf("AddCode live: %v", err)
	}

	n, err := s.ExpireCodes(time.Now())
	if err != nil {
		t.Fatalf("ExpireCodes: %v", err)
	}
	if n != 1 {
		t.Errorf("ExpireCodes removed %d, want 1", n)
	}
	if _, err := s.CodeByHash("live"); err != nil {
		t.Errorf("live code was removed: %v", err)
	}
}

func TestCodeHashEqual(t *testing.T) {
	if !CodeHashEqual("abc", "abc") {
		t.Error("equal hashes compared unequal")
	}
	if CodeHashEqual("abc", "abd") {
		t.Error("different hashes compared equal")
	}
	if CodeHashEqual("abc", "abcd") {
		t.Error("different-length hashes compared equal")
	}
}
