// Package limit holds the token bucket that dockergate uses for every rate:
// the per-bot rates, the global rate and the flood defence of the listener.
package limit

import (
	"sync"
	"time"
)

// Bucket is a token bucket. It is safe for concurrent use.
type Bucket struct {
	mu     sync.Mutex
	rate   float64 // tokens per second
	burst  float64
	tokens float64
	last   time.Time
}

// New returns a full bucket. rate is tokens per second, burst the capacity.
func New(rate, burst float64, now time.Time) *Bucket {
	return &Bucket{rate: rate, burst: burst, tokens: burst, last: now}
}

// PerWindow returns a bucket that allows n events per window, in a burst of n.
func PerWindow(n int, window time.Duration, now time.Time) *Bucket {
	return New(float64(n)/window.Seconds(), float64(n), now)
}

// Allow takes a token, or reports that there is none.
func (b *Bucket) Allow(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if now.After(b.last) {
		b.tokens += now.Sub(b.last).Seconds() * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Last is the time of the last refill; the flood defence uses it to drop idle
// buckets.
func (b *Bucket) Last() time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.last
}
