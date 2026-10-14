package p2p

import (
	"sync"
	"testing"
	"time"
)

func TestLimiterAllowsUpToMax(t *testing.T) {
	l := NewLimiterWithPolicy(3, time.Minute)
	addr := "10.0.0.9:5555"

	for i := 0; i < 3; i++ {
		if !l.Allow(addr) {
			t.Fatalf("attempt %d was blocked before the limit", i+1)
		}
		l.Fail(addr)
	}
	if l.Allow(addr) {
		t.Error("attempt past the limit was allowed")
	}
}

func TestLimiterResetsAfterWindow(t *testing.T) {
	l := NewLimiterWithPolicy(2, time.Minute)
	now := time.Now()
	l.now = func() time.Time { return now }

	addr := "10.0.0.9:1"
	l.Fail(addr)
	l.Fail(addr)
	if l.Allow(addr) {
		t.Fatal("address was not limited")
	}

	// Move past the window without sleeping.
	now = now.Add(61 * time.Second)
	if !l.Allow(addr) {
		t.Error("address was still limited after the window elapsed")
	}
}

func TestLimiterSuccessClears(t *testing.T) {
	l := NewLimiterWithPolicy(2, time.Minute)
	addr := "10.0.0.9:2"

	l.Fail(addr)
	l.Success(addr)
	if !l.Allow(addr) {
		t.Error("a successful authentication did not clear the failure count")
	}
}

func TestLimiterIsPerAddress(t *testing.T) {
	l := NewLimiterWithPolicy(1, time.Minute)
	a, b := "10.0.0.1:1", "10.0.0.2:1"

	l.Fail(a)
	if l.Allow(a) {
		t.Error("address a was not limited")
	}
	if !l.Allow(b) {
		t.Error("address b was limited because of address a")
	}
}

func TestLimiterRetryAfter(t *testing.T) {
	l := NewLimiterWithPolicy(3, 30*time.Second)
	now := time.Now()
	l.now = func() time.Time { return now }

	addr := "10.0.0.3:1"
	if d := l.RetryAfter(addr); d != 0 {
		t.Errorf("RetryAfter with no history = %v, want 0", d)
	}

	l.Fail(addr)
	d := l.RetryAfter(addr)
	if d <= 0 || d > 30*time.Second {
		t.Errorf("RetryAfter = %v, want a positive value no greater than the window", d)
	}
}

func TestLimiterConcurrentAccess(t *testing.T) {
	l := NewLimiter()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			addr := "10.0.0.1:1"
			if i%2 == 0 {
				addr = "10.0.0.2:2"
			}
			l.Allow(addr)
			l.Fail(addr)
			l.RetryAfter(addr)
		}(i)
	}
	wg.Wait()
}

func TestNewLimiterSanitisesPolicy(t *testing.T) {
	l := NewLimiterWithPolicy(0, 0)
	if l.maxAttempts != DefaultAuthMaxAttempts {
		t.Errorf("maxAttempts = %d, want %d", l.maxAttempts, DefaultAuthMaxAttempts)
	}
	if l.window != DefaultAuthWindow {
		t.Errorf("window = %v, want %v", l.window, DefaultAuthWindow)
	}
}
