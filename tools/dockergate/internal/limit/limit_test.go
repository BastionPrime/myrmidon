package limit

import (
	"testing"
	"time"
)

func TestBucketBurstThenRefill(t *testing.T) {
	now := time.Unix(1000, 0)
	b := New(2, 3, now)
	for i := 0; i < 3; i++ {
		if !b.Allow(now) {
			t.Fatalf("burst token %d refused", i)
		}
	}
	if b.Allow(now) {
		t.Fatal("a fourth token in the same instant")
	}
	// Half a second at 2/s is one token.
	if !b.Allow(now.Add(500 * time.Millisecond)) {
		t.Fatal("no token after the refill")
	}
	if b.Allow(now.Add(500 * time.Millisecond)) {
		t.Fatal("two tokens for one refill")
	}
}

func TestBucketNeverExceedsBurst(t *testing.T) {
	now := time.Unix(1000, 0)
	b := New(10, 2, now)
	later := now.Add(time.Hour)
	if !b.Allow(later) || !b.Allow(later) {
		t.Fatal("full bucket refused")
	}
	if b.Allow(later) {
		t.Fatal("bucket grew past its burst")
	}
}

func TestPerWindow(t *testing.T) {
	now := time.Unix(1000, 0)
	b := PerWindow(6, 10*time.Minute, now)
	for i := 0; i < 6; i++ {
		if !b.Allow(now) {
			t.Fatalf("event %d refused", i)
		}
	}
	if b.Allow(now) {
		t.Fatal("seventh event in the window")
	}
	// One token comes back after window/n = 100 s.
	if !b.Allow(now.Add(101 * time.Second)) {
		t.Fatal("no token after window/n")
	}
}

func TestClockGoingBackwardsDoesNotMintTokens(t *testing.T) {
	now := time.Unix(1000, 0)
	b := New(1, 1, now)
	if !b.Allow(now) {
		t.Fatal("first")
	}
	if b.Allow(now.Add(-time.Hour)) {
		t.Fatal("a token from a clock that went back")
	}
}
