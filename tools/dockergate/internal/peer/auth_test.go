package peer_test

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/peer"
)

const notBoardMain = "caller_not_board_main"
const resolveFailed = "caller_resolve_failed"

func pinned(t *testing.T) (*world, *peer.Auth, chan peer.ResolveEvent) {
	t.Helper()
	w := newWorld()
	a, events := newAuth(w)
	if err := a.Resolve(context.Background()); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	waitEvent(t, events)
	return w, a, events
}

func TestNoPinRefusesEveryoneAndStartsAResolve(t *testing.T) {
	w := newWorld()
	w.boardErr = errors.New("daemon down")
	a, events := newAuth(w)

	if a.Pinned() != nil {
		t.Fatal("a pin before any resolve")
	}
	d := a.AdmitCred(cred(nodePID))
	if d.Verdict != peer.Reply || d.Code != resolveFailed || d.Pin != nil {
		t.Fatalf("%+v", d)
	}
	ev := waitEvent(t, events)
	if ev.Reason != peer.ReasonBoardNotRunning || ev.Pin != nil {
		t.Fatalf("event %+v", ev)
	}
	if a.ResolveFailures() != 1 {
		t.Fatalf("failures %d", a.ResolveFailures())
	}

	// Within the minimal interval a second connection starts no second resolve,
	// even after the daemon is back.
	w.mu.Lock()
	w.boardErr = nil
	w.mu.Unlock()
	if d := a.AdmitCred(cred(nodePID)); d.Code != resolveFailed || d.Verdict != peer.Reply {
		t.Fatalf("%+v", d)
	}
	noEvent(t, events)

	// After the interval it does.
	w.advance(3 * time.Second)
	if d := a.AdmitCred(cred(nodePID)); d.Code != resolveFailed {
		t.Fatalf("%+v", d)
	}
	ev = waitEvent(t, events)
	if ev.Pin == nil || ev.Pin.PID != nodePID || !ev.Changed {
		t.Fatalf("event %+v", ev)
	}
	d = a.AdmitCred(cred(nodePID))
	if d.Verdict != peer.Accept || d.Pin == nil || d.Pin.PID != nodePID {
		t.Fatalf("%+v", d)
	}
}

func TestPinnedCallerIsAccepted(t *testing.T) {
	_, a, _ := pinned(t)
	d := a.AdmitCred(cred(nodePID))
	if d.Verdict != peer.Accept || d.Pin == nil || d.Pin != a.Pinned() {
		t.Fatalf("%+v", d)
	}
	if !a.Valid(d.Pin) {
		t.Fatal("the pin of a fresh connection is not valid")
	}
}

func TestOtherCallersAreRefused(t *testing.T) {
	_, a, _ := pinned(t)
	cases := []struct {
		name string
		c    peer.Cred
	}{
		{"a sibling with the same uid and gid", peer.Cred{PID: 4242, UID: appUID, GID: appGID}},
		{"a foreign uid", peer.Cred{PID: 4243, UID: 1001, GID: appGID}},
		{"a foreign gid", peer.Cred{PID: 4244, UID: appUID, GID: 1001}},
		{"root", peer.Cred{PID: 4245, UID: 0, GID: 0}},
		{"the pinned pid with a foreign uid", peer.Cred{PID: nodePID, UID: 1001, GID: appGID}},
		{"the pinned pid with a foreign gid", peer.Cred{PID: nodePID, UID: appUID, GID: 1001}},
		{"pid zero with the right ids", peer.Cred{PID: 0, UID: appUID, GID: appGID}},
		{"the init of the board container", peer.Cred{PID: tiniPID, UID: appUID, GID: appGID}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := a.AdmitCred(tc.c)
			if d.Verdict != peer.Reply || d.Code != notBoardMain || d.Pin != nil {
				t.Fatalf("%+v", d)
			}
		})
	}
}

// Nothing about a foreign pid is read from /proc (spec 4.3): its entry is what
// the attacker controls.
func TestForeignCallerNeverCausesAProcRead(t *testing.T) {
	w, a, _ := pinned(t)
	w.add(5000, proc{comm: "attacker", ppid: 1, start: 1, uids: all4(appUID), gids: all4(appGID), argv: nodeArgv(), leaf: scope()})
	for i := 0; i < 50; i++ {
		w.advance(2 * time.Second)
		a.AdmitCred(peer.Cred{PID: 5000 + i, UID: appUID, GID: appGID})
	}
	for i := 0; i < 50; i++ {
		if n := w.readsOf(5000 + i); n != 0 {
			t.Fatalf("pid %d was read %d times", 5000+i, n)
		}
	}
}

// RT2_6: the pinned pid is reused by another process.
func TestRedTeam_RT2_6_PidReuse(t *testing.T) {
	t.Run("a connection of the previous process is not valid", func(t *testing.T) {
		w, a, events := pinned(t)
		d := a.AdmitCred(cred(nodePID))
		if d.Verdict != peer.Accept {
			t.Fatalf("%+v", d)
		}
		old := d.Pin

		// Same pid, another process: another starttime.
		w.set(nodePID, func(p *proc) { p.start = 9999 })
		if a.Valid(old) {
			t.Fatal("a connection of the previous process is still valid")
		}
		if a.Pinned() != nil {
			t.Fatal("the pin of a dead process was kept")
		}
		// The impostor with the reused pid does not get in.
		d = a.AdmitCred(cred(nodePID))
		if d.Verdict != peer.Reply || d.Pin != nil {
			t.Fatalf("%+v", d)
		}
		// The resolve that the refusal started finds a process outside the window:
		// there is no pin either.
		ev := waitEvent(t, events)
		if ev.Pin != nil || ev.Reason != peer.ReasonMismatchPrefix+"window" {
			t.Fatalf("event %+v", ev)
		}
	})

	t.Run("a new connection with the reused pid is refused", func(t *testing.T) {
		w, a, events := pinned(t)
		w.set(nodePID, func(p *proc) { p.start = 9999 })
		d := a.AdmitCred(cred(nodePID))
		if d.Verdict != peer.Reply || d.Code != notBoardMain || d.Pin != nil {
			t.Fatalf("%+v", d)
		}
		if a.Pinned() != nil {
			t.Fatal("the pin of a replaced process was kept")
		}
		ev := waitEvent(t, events)
		if ev.Pin != nil {
			t.Fatalf("event %+v", ev)
		}
	})
}

// RT2_6: adoption. The board's node dies, an orphan with a forged argv is
// reparented to the init of the container.
func TestRedTeam_RT2_6_AdoptionWithForgedArgv(t *testing.T) {
	w, a, events := pinned(t)
	old := a.Pinned()
	w.remove(nodePID)
	w.add(700, proc{comm: "evil", ppid: tiniPID, start: 1200, uids: all4(appUID), gids: all4(appGID), argv: []string{"evil"}, leaf: scope()})

	if a.Valid(old) {
		t.Fatal("the pin of a dead process is valid")
	}
	// The forged process is never the pin, whatever it connects as.
	d := a.AdmitCred(cred(700))
	if d.Verdict != peer.Reply || d.Pin != nil {
		t.Fatalf("%+v", d)
	}
	ev := waitEvent(t, events)
	if ev.Pin != nil || ev.Reason != peer.ReasonMismatchPrefix+"argv" {
		t.Fatalf("event %+v", ev)
	}
	if a.Pinned() != nil {
		t.Fatal("a pin exists")
	}
}

func TestStaleLivenessOfAForeignConnection(t *testing.T) {
	w, a, events := pinned(t)
	w.remove(nodePID)
	// Within the cache time the pin is trusted for a foreign connection: the
	// pinned pid is read at most once a second and only by its own request.
	if d := a.AdmitCred(peer.Cred{PID: 4242, UID: appUID, GID: appGID}); d.Code != notBoardMain {
		t.Fatalf("%+v", d)
	}
	w.advance(5 * time.Second)
	d := a.AdmitCred(peer.Cred{PID: 4242, UID: appUID, GID: appGID})
	if d.Code != resolveFailed || a.Pinned() != nil {
		t.Fatalf("%+v pin %v", d, a.Pinned())
	}
	waitEvent(t, events)
}

func TestValidNeedsTheCurrentPin(t *testing.T) {
	w, a, _ := pinned(t)
	old := a.Pinned()
	if !a.Valid(old) {
		t.Fatal("a fresh pin is not valid")
	}
	if a.Valid(nil) {
		t.Fatal("nil is valid")
	}
	if a.Valid(&peer.Pin{PID: nodePID, StartTime: 1010, ContainerID: "other", P0: tiniPID, S0: 1000}) {
		t.Fatal("a pin of another container is valid")
	}

	// The board is recreated and pinned again: the connections of the old
	// process are not valid any more.
	newID := "cd" + boardID[2:]
	w.remove(tiniPID)
	w.remove(nodePID)
	w.add(500, proc{comm: "tini", ppid: 1, start: 5000, uids: all4(rootUID), gids: all4(rootUID), leaf: "docker-" + newID + ".scope"})
	w.add(501, proc{comm: "node", ppid: 500, start: 5010, uids: all4(appUID), gids: all4(appGID), argv: nodeArgv(), leaf: "docker-" + newID + ".scope"})
	w.setBoard(func(b *peer.BoardState) { b.ID = newID; b.Pid = 500 })
	if err := a.Resolve(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a.Valid(old) {
		t.Fatal("the connection of the previous board is valid")
	}
	if d := a.AdmitCred(cred(501)); d.Verdict != peer.Accept {
		t.Fatalf("%+v", d)
	}
}

func TestResolveOfTheSameProcessKeepsThePin(t *testing.T) {
	w, a, events := pinned(t)
	first := a.Pinned()
	w.advance(time.Minute)
	if err := a.Resolve(context.Background()); err != nil {
		t.Fatal(err)
	}
	ev := waitEvent(t, events)
	if ev.Changed {
		t.Fatal("a resolve of the same process reported a change")
	}
	if a.Pinned() != first {
		t.Fatal("the pin object changed, so the connections of the board would close")
	}
	if !a.Valid(first) {
		t.Fatal("not valid")
	}
}

func TestTick(t *testing.T) {
	t.Run("without a pin it resolves", func(t *testing.T) {
		w := newWorld()
		a, events := newAuth(w)
		a.Tick(context.Background())
		ev := waitEvent(t, events)
		if ev.Pin == nil || a.Pinned() == nil {
			t.Fatalf("%+v", ev)
		}
	})
	t.Run("a healthy pin needs no resolve", func(t *testing.T) {
		_, a, events := pinned(t)
		a.Tick(context.Background())
		noEvent(t, events)
	})
	t.Run("an error of the daemon keeps the pin", func(t *testing.T) {
		w, a, events := pinned(t)
		w.mu.Lock()
		w.boardErr = errors.New("daemon down")
		w.mu.Unlock()
		a.Tick(context.Background())
		noEvent(t, events)
		if a.Pinned() == nil {
			t.Fatal("the pin was dropped")
		}
	})
	t.Run("a board with another main pid is pinned again", func(t *testing.T) {
		w, a, events := pinned(t)
		old := a.Pinned()
		newID := "cd" + boardID[2:]
		w.remove(tiniPID)
		w.remove(nodePID)
		w.add(500, proc{comm: "tini", ppid: 1, start: 5000, uids: all4(rootUID), gids: all4(rootUID), leaf: "docker-" + newID + ".scope"})
		w.add(501, proc{comm: "node", ppid: 500, start: 5010, uids: all4(appUID), gids: all4(appGID), argv: nodeArgv(), leaf: "docker-" + newID + ".scope"})
		w.setBoard(func(b *peer.BoardState) { b.ID = newID; b.Pid = 500 })
		a.Tick(context.Background())
		ev := waitEvent(t, events)
		if !ev.Changed || ev.Pin == nil || ev.Pin.PID != 501 || a.Valid(old) {
			t.Fatalf("%+v", ev)
		}
	})
	t.Run("a board that stopped drops the pin", func(t *testing.T) {
		w, a, events := pinned(t)
		w.setBoard(func(b *peer.BoardState) { b.Running = false })
		a.Tick(context.Background())
		ev := waitEvent(t, events)
		if ev.Reason != peer.ReasonBoardNotRunning || a.Pinned() != nil {
			t.Fatalf("%+v", ev)
		}
	})
	t.Run("a dead pinned process is replaced", func(t *testing.T) {
		w, a, events := pinned(t)
		w.remove(nodePID)
		a.Tick(context.Background())
		ev := waitEvent(t, events)
		if ev.Reason != peer.ReasonNoChildren || a.Pinned() != nil {
			t.Fatalf("%+v", ev)
		}
	})
}

func TestUIDMode(t *testing.T) {
	w := newWorld()
	c := w.caller()
	c.Mode = config.ModeUID
	a := peer.New(peer.Options{Caller: c, Proc: w, Board: w, Flood: floodConfig(), Now: w.clock})

	if a.Pinned() == nil {
		t.Fatal("the uid mode has no pin placeholder")
	}
	d := a.AdmitCred(cred(9999))
	if d.Verdict != peer.Accept || d.Pin == nil {
		t.Fatalf("%+v", d)
	}
	if !a.Valid(d.Pin) {
		t.Fatal("not valid")
	}
	for _, bad := range []peer.Cred{
		{PID: 9999, UID: 1001, GID: appGID},
		{PID: 9999, UID: appUID, GID: 1001},
		{PID: 0, UID: appUID, GID: appGID},
	} {
		if d := a.AdmitCred(bad); d.Verdict != peer.Reply || d.Code != notBoardMain {
			t.Fatalf("%+v: %+v", bad, d)
		}
	}
	// No /proc reads, no resolves.
	if err := a.Resolve(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.Kick()
	a.Tick(context.Background())
	if w.readsOf(nodePID) != 0 || w.readsOf(tiniPID) != 0 {
		t.Fatal("the uid mode read /proc")
	}
}

func TestSoCredReadsThePeerOfARealSocket(t *testing.T) {
	dir, err := os.MkdirTemp("", "dg")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "s.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	done := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			done <- nil
			return
		}
		done <- c
	}()
	client, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-done
	if server == nil {
		t.Fatal("accept failed")
	}
	defer server.Close()

	got, err := peer.SoCred(server)
	if err != nil {
		t.Fatal(err)
	}
	want := peer.Cred{PID: os.Getpid(), UID: uint32(os.Getuid()), GID: uint32(os.Getgid())}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	// The same through Admit: the uid mode with our own ids lets us in.
	c := config.Caller{UID: want.UID, GID: want.GID, Mode: config.ModeUID}
	a := peer.New(peer.Options{Caller: c, Flood: floodConfig()})
	if d := a.Admit(server); d.Verdict != peer.Accept || d.Cred != want {
		t.Fatalf("%+v", d)
	}
	c.UID++
	a = peer.New(peer.Options{Caller: c, Flood: floodConfig()})
	if d := a.Admit(server); d.Verdict != peer.Reply || d.Code != notBoardMain {
		t.Fatalf("%+v", d)
	}
}

func TestSoCredRefusesAConnectionThatIsNotUnix(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	if _, err := peer.SoCred(a); err == nil {
		t.Fatal("credentials of a pipe")
	}
	// A connection whose credentials cannot be read is refused like a foreign
	// caller and counted under pid 0.
	c := config.Caller{UID: appUID, GID: appGID, Mode: config.ModeUID}
	auth := peer.New(peer.Options{Caller: c, Flood: floodConfig()})
	d := auth.Admit(a)
	if d.Verdict != peer.Reply || d.Code != notBoardMain || d.Cred.PID != 0 {
		t.Fatalf("%+v", d)
	}
}
