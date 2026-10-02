package peer_test

import (
	"testing"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/peer"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newClock() *clock { return &clock{t: time.Unix(1_800_000_000, 0)} }

// RT2_2: a flood of connections from one pid.
func TestRedTeam_RT2_2_FloodOnePid(t *testing.T) {
	c := newClock()
	f := peer.NewFlood(floodConfig(), c.now)

	replied := 0
	for i := 0; i < 1000; i++ {
		if f.Admit(4242) {
			replied++
		}
	}
	if replied != 20 {
		t.Fatalf("%d answers in one instant, want the burst of 20", replied)
	}
	if f.Replied() != 20 || f.Dropped() != 980 {
		t.Fatalf("replied %d dropped %d", f.Replied(), f.Dropped())
	}
	if f.Banned() != 1 {
		t.Fatalf("banned %d", f.Banned())
	}

	// During the ban nothing gets an answer, however long the pause between
	// connections.
	c.advance(59 * time.Second)
	if f.Admit(4242) {
		t.Fatal("answered during the ban")
	}
	// After the ban the pid starts again with a full bucket.
	c.advance(2 * time.Second)
	if !f.Admit(4242) {
		t.Fatal("not answered after the ban")
	}
	if f.Banned() != 0 {
		t.Fatalf("banned %d", f.Banned())
	}
}

func TestFloodRefillsAtTheRate(t *testing.T) {
	c := newClock()
	f := peer.NewFlood(floodConfig(), c.now)
	for i := 0; i < 20; i++ {
		if !f.Admit(7) {
			t.Fatalf("connection %d within the burst was refused", i)
		}
	}
	// Ten connections per second are answered in the long run.
	c.advance(time.Second)
	got := 0
	for i := 0; i < 10; i++ {
		if f.Admit(7) {
			got++
		}
		c.advance(100 * time.Millisecond)
	}
	if got != 10 {
		t.Fatalf("%d of 10 answered at the rate", got)
	}
}

func TestRedTeam_RT2_2_FloodOfNewPids(t *testing.T) {
	c := newClock()
	f := peer.NewFlood(floodConfig(), c.now)
	replied := 0
	for pid := 10000; pid < 11000; pid++ {
		if f.Admit(pid) {
			replied++
		}
	}
	if replied != 400 {
		t.Fatalf("%d answers over the global burst of 400", replied)
	}
	if f.Dropped() != 600 {
		t.Fatalf("dropped %d", f.Dropped())
	}
}

func TestFloodTableIsBounded(t *testing.T) {
	c := newClock()
	cfg := floodConfig()
	cfg.MaxTracked = 10
	cfg.GlobalBurst = 1000
	f := peer.NewFlood(cfg, c.now)
	for pid := 1; pid <= 10; pid++ {
		if !f.Admit(pid) {
			t.Fatalf("pid %d refused", pid)
		}
	}
	if f.Admit(11) {
		t.Fatal("an eleventh pid was tracked")
	}
	if !f.Admit(1) {
		t.Fatal("a tracked pid was refused")
	}
	// Quiet pids are forgotten, so the table does not stay full.
	c.advance(3 * time.Minute)
	if !f.Admit(11) {
		t.Fatal("the table was not swept")
	}
}

func TestFloodReport(t *testing.T) {
	c := newClock()
	f := peer.NewFlood(floodConfig(), c.now)
	if _, ok := f.TakeReport(); ok {
		t.Fatal("a report without drops")
	}
	for i := 0; i < 30; i++ {
		f.Admit(1)
	}
	n, ok := f.TakeReport()
	if !ok || n != 10 {
		t.Fatalf("report %d %v", n, ok)
	}
	// Once per minute, while it grows.
	for i := 0; i < 5; i++ {
		f.Admit(1)
	}
	if _, ok := f.TakeReport(); ok {
		t.Fatal("a second report within the minute")
	}
	c.advance(61 * time.Second)
	if n, ok := f.TakeReport(); !ok || n != 5 {
		t.Fatalf("report %d %v", n, ok)
	}
	c.advance(61 * time.Second)
	if _, ok := f.TakeReport(); ok {
		t.Fatal("a report without growth")
	}
}

func TestFloodFlush(t *testing.T) {
	c := newClock()
	cfg := floodConfig()
	cfg.GlobalBurst = 1000
	f := peer.NewFlood(cfg, c.now)
	for i := 0; i < 5; i++ {
		f.Admit(30)
	}
	for i := 0; i < 3; i++ {
		f.Admit(20)
	}
	f.Admit(10)
	f.Admit(11)

	w := newWorld()
	w.add(30, proc{comm: "thirty"})
	w.add(20, proc{comm: "twenty"})
	w.add(10, proc{comm: "ten"})
	w.add(11, proc{comm: "eleven"})

	list, others := f.Flush(w, 2)
	if len(list) != 2 || list[0].PID != 30 || list[0].Count != 5 || list[1].PID != 20 || list[1].Count != 3 {
		t.Fatalf("list %+v", list)
	}
	if list[0].Comm != "thirty" || list[1].Comm != "twenty" {
		t.Fatalf("comm %+v", list)
	}
	if others != 2 {
		t.Fatalf("others %d", others)
	}
	// The command name is looked up only for the pids that are reported.
	if w.readsOf(10) != 0 || w.readsOf(11) != 0 {
		t.Fatal("/proc was read for a pid that is not reported")
	}
	// A flush forgets what it returned.
	list, others = f.Flush(w, 2)
	if len(list) != 0 || others != 0 {
		t.Fatalf("second flush %+v %d", list, others)
	}
}

// The pinned pid does not go through the flood defence: while foreign callers
// flood, it gets its answers.
func TestFloodNeverBlocksThePinnedPid(t *testing.T) {
	_, a, _ := pinned(t)
	for i := 0; i < 1000; i++ {
		a.AdmitCred(peer.Cred{PID: 4242, UID: appUID, GID: appGID})
		a.AdmitCred(peer.Cred{PID: 20000 + i, UID: appUID, GID: appGID})
	}
	if a.Flood().Dropped() == 0 {
		t.Fatal("no foreign connection was dropped")
	}
	for i := 0; i < 100; i++ {
		if d := a.AdmitCred(cred(nodePID)); d.Verdict != peer.Accept {
			t.Fatalf("request %d of the pinned pid: %+v", i, d)
		}
	}
}

func TestFloodDropVerdict(t *testing.T) {
	_, a, _ := pinned(t)
	verdicts := map[peer.Verdict]int{}
	for i := 0; i < 100; i++ {
		verdicts[a.AdmitCred(peer.Cred{PID: 4242, UID: 1, GID: 1}).Verdict]++
	}
	if verdicts[peer.Reply] != 20 || verdicts[peer.Drop] != 80 || verdicts[peer.Accept] != 0 {
		t.Fatalf("%v", verdicts)
	}
}
