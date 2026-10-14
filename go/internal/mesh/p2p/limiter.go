package p2p

import (
	"sync"
	"time"
)

// Limiter throttles repeated failed authentication attempts from one address.
// The prototype keeps this in memory: a restart clearing the counters is
// acceptable, since a rate limiter that resets on restart is still far better
// than none, and a peer must reconnect to reach the counter again.
type Limiter struct {
	mu       sync.Mutex
	attempts map[string]*attemptWindow

	maxAttempts int
	window      time.Duration
	now         func() time.Time
}

type attemptWindow struct {
	count int
	reset time.Time
}

// DefaultAuthMaxAttempts is how many failed AUTH attempts a single remote
// address may make per DefaultAuthWindow.
const DefaultAuthMaxAttempts = 5

// DefaultAuthWindow is the sliding period for the attempt limit.
const DefaultAuthWindow = time.Minute

// NewLimiter builds a limiter with the default policy.
func NewLimiter() *Limiter {
	return NewLimiterWithPolicy(DefaultAuthMaxAttempts, DefaultAuthWindow)
}

// NewLimiterWithPolicy builds a limiter with an explicit policy. now is
// injectable so tests need not sleep.
func NewLimiterWithPolicy(maxAttempts int, window time.Duration) *Limiter {
	if maxAttempts < 1 {
		maxAttempts = DefaultAuthMaxAttempts
	}
	if window <= 0 {
		window = DefaultAuthWindow
	}
	return &Limiter{
		attempts:    make(map[string]*attemptWindow),
		maxAttempts: maxAttempts,
		window:      window,
		now:         time.Now,
	}
}

// Allow reports whether an address may attempt authentication now.
func (l *Limiter) Allow(addr string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	w, ok := l.attempts[addr]
	if !ok {
		return true
	}
	if now.After(w.reset) {
		delete(l.attempts, addr)
		return true
	}
	return w.count < l.maxAttempts
}

// Fail records a failed attempt against an address.
func (l *Limiter) Fail(addr string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	w, ok := l.attempts[addr]
	if !ok || now.After(w.reset) {
		l.attempts[addr] = &attemptWindow{count: 1, reset: now.Add(l.window)}
		return
	}
	w.count++
}

// Success clears an address's failure count after a successful authentication.
func (l *Limiter) Success(addr string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, addr)
}

// RetryAfter reports how long an address must wait before being allowed again.
func (l *Limiter) RetryAfter(addr string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()

	w, ok := l.attempts[addr]
	if !ok {
		return 0
	}
	d := w.reset.Sub(l.now())
	if d < 0 {
		return 0
	}
	return d
}
