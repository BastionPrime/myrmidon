package peer_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/peer"
)

func resolveOK(t *testing.T, w *world) (*peer.Pin, []peer.Decoy) {
	t.Helper()
	pin, decoys, err := w.resolver().Resolve(context.Background())
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	return pin, decoys
}

func resolveFails(t *testing.T, w *world, reason string) {
	t.Helper()
	pin, decoys, err := w.resolver().Resolve(context.Background())
	if err == nil {
		t.Fatalf("pinned pid %d, want %s", pin.PID, reason)
	}
	got, ok := peer.IsResolveError(err)
	if !ok {
		t.Fatalf("not a resolve error: %v", err)
	}
	if got != reason {
		t.Fatalf("reason %q, want %q", got, reason)
	}
	if pin != nil || decoys != nil {
		t.Fatal("a failed resolve returned a pin or decoys")
	}
	if !strings.Contains(err.Error(), reason) {
		t.Fatalf("error text %q lacks the reason", err.Error())
	}
}

func TestResolvePinsTheFirstChild(t *testing.T) {
	w := newWorld()
	pin, decoys := resolveOK(t, w)
	if pin.PID != nodePID || pin.StartTime != 1010 || pin.Comm != "node" {
		t.Fatalf("pin %+v", pin)
	}
	if pin.ContainerID != boardID || pin.P0 != tiniPID || pin.S0 != 1000 {
		t.Fatalf("pin %+v", pin)
	}
	if !pin.ResolvedAt.Equal(w.clock()) {
		t.Fatalf("resolved at %v", pin.ResolvedAt)
	}
	if len(decoys) != 0 {
		t.Fatalf("decoys %+v", decoys)
	}
}

func TestPinSame(t *testing.T) {
	a := &peer.Pin{PID: 1, StartTime: 2, ContainerID: "c", P0: 3, S0: 4}
	b := *a
	b.ResolvedAt = time.Unix(5, 0)
	b.Comm = "other"
	if !a.Same(&b) {
		t.Fatal("the time of the resolve and the name must not matter")
	}
	for name, mut := range map[string]func(*peer.Pin){
		"pid":       func(p *peer.Pin) { p.PID = 9 },
		"starttime": func(p *peer.Pin) { p.StartTime = 9 },
		"container": func(p *peer.Pin) { p.ContainerID = "d" },
		"p0":        func(p *peer.Pin) { p.P0 = 9 },
		"s0":        func(p *peer.Pin) { p.S0 = 9 },
	} {
		c := *a
		mut(&c)
		if a.Same(&c) {
			t.Errorf("%s: pins differ but Same is true", name)
		}
	}
	var nilPin *peer.Pin
	if !nilPin.Same(nil) || a.Same(nil) || nilPin.Same(a) {
		t.Fatal("nil pins")
	}
}

// RT2_1: a decoy in the boot window must neither take the pin nor switch the
// feature off.
func TestRedTeam_RT2_1_Decoy(t *testing.T) {
	t.Run("a matching orphan later than node is reported and does not matter", func(t *testing.T) {
		w := newWorld()
		w.add(102, w.procs[nodePID])
		w.set(102, func(p *proc) { p.start = 1015 })
		pin, decoys := resolveOK(t, w)
		if pin.PID != nodePID {
			t.Fatalf("pinned %d", pin.PID)
		}
		if len(decoys) != 1 || decoys[0].PID != 102 || decoys[0].Comm != "node" || decoys[0].StartDiff != 5 {
			t.Fatalf("decoys %+v", decoys)
		}
	})

	t.Run("the decoy is refused when it connects", func(t *testing.T) {
		w := newWorld()
		w.add(102, w.procs[nodePID])
		w.set(102, func(p *proc) { p.start = 1015 })
		a, events := newAuth(w)
		if err := a.Resolve(context.Background()); err != nil {
			t.Fatal(err)
		}
		ev := waitEvent(t, events)
		if len(ev.Decoys) != 1 || a.ResolveDecoys() != 1 {
			t.Fatalf("decoys %+v counter %d", ev.Decoys, a.ResolveDecoys())
		}
		if d := a.AdmitCred(cred(nodePID)); d.Verdict != peer.Accept {
			t.Fatalf("node: %+v", d)
		}
		d := a.AdmitCred(cred(102))
		if d.Verdict != peer.Reply || d.Code != "caller_not_board_main" {
			t.Fatalf("decoy: %+v", d)
		}
	})

	t.Run("an orphan with a forged argv and a late start gets nothing", func(t *testing.T) {
		w := newWorld()
		w.add(102, proc{comm: "evil", ppid: tiniPID, start: 9000, uids: all4(appUID), gids: all4(appGID), argv: []string{"evil"}, leaf: scope()})
		pin, decoys := resolveOK(t, w)
		if pin.PID != nodePID || len(decoys) != 0 {
			t.Fatalf("pin %+v decoys %+v", pin, decoys)
		}
	})

	t.Run("node's argv differs from the config while a decoy matches: no pin", func(t *testing.T) {
		w := newWorld()
		w.set(nodePID, func(p *proc) { p.argv = []string{"node", "other.js"} })
		w.add(102, proc{comm: "node", ppid: tiniPID, start: 1015, uids: all4(appUID), gids: all4(appGID), argv: nodeArgv(), leaf: scope()})
		resolveFails(t, w, peer.ReasonMismatchPrefix+"argv")
	})

	t.Run("the first child fails the uid while the next one passes everything: no pin", func(t *testing.T) {
		w := newWorld()
		w.set(nodePID, func(p *proc) { p.uids = all4(1001) })
		w.add(102, proc{comm: "node", ppid: tiniPID, start: 1015, uids: all4(appUID), gids: all4(appGID), argv: nodeArgv(), leaf: scope()})
		resolveFails(t, w, peer.ReasonMismatchPrefix+"uid")
	})

	t.Run("two children with the smallest starttime: no pin", func(t *testing.T) {
		w := newWorld()
		w.add(102, w.procs[nodePID])
		resolveFails(t, w, peer.ReasonFirstChildTie)
	})

	t.Run("a tie that is not at the front does not matter", func(t *testing.T) {
		w := newWorld()
		w.add(102, w.procs[nodePID])
		w.add(103, w.procs[nodePID])
		w.set(102, func(p *proc) { p.start = 1020 })
		w.set(103, func(p *proc) { p.start = 1020 })
		pin, decoys := resolveOK(t, w)
		if pin.PID != nodePID || len(decoys) != 2 {
			t.Fatalf("pin %+v decoys %+v", pin, decoys)
		}
	})

	t.Run("an orphan that starts before node is the first child and fails on its argv", func(t *testing.T) {
		w := newWorld()
		// Earlier than node, so it is the first child; its argv is forged.
		w.add(99, proc{comm: "evil", ppid: tiniPID, start: 1005, uids: all4(appUID), gids: all4(appGID), argv: []string{"evil"}, leaf: scope()})
		resolveFails(t, w, peer.ReasonMismatchPrefix+"argv")
	})
}

func TestResolveFailures(t *testing.T) {
	cases := []struct {
		name   string
		mut    func(*world)
		reason string
	}{
		{"board container not running", func(w *world) { w.setBoard(func(b *peer.BoardState) { b.Running = false }) }, peer.ReasonBoardNotRunning},
		{"board container without a pid", func(w *world) { w.setBoard(func(b *peer.BoardState) { b.Pid = 0 }) }, peer.ReasonBoardNotRunning},
		{"board container without an id", func(w *world) { w.setBoard(func(b *peer.BoardState) { b.ID = "" }) }, peer.ReasonBoardNotRunning},
		{"daemon error", func(w *world) { w.boardErr = errors.New("boom") }, peer.ReasonBoardNotRunning},
		{"init process gone", func(w *world) { w.remove(tiniPID) }, peer.ReasonBoardNotRunning},
		{"label missing", func(w *world) { w.setBoard(func(b *peer.BoardState) { b.Labels = map[string]string{"extra": "yes"} }) }, peer.ReasonBoardLabels},
		{"label with another value", func(w *world) { w.setBoard(func(b *peer.BoardState) { b.Labels["role"] = "shell" }) }, peer.ReasonBoardLabels},
		{"no labels", func(w *world) { w.setBoard(func(b *peer.BoardState) { b.Labels = nil }) }, peer.ReasonBoardLabels},
		{"init in another cgroup", func(w *world) {
			w.set(tiniPID, func(p *proc) { p.leaf = "docker-" + strings.Repeat("cd", 32) + ".scope" })
		}, peer.ReasonBoardCgroup},
		{"init cgroup is not a docker scope", func(w *world) { w.set(tiniPID, func(p *proc) { p.leaf = "init.scope" }) }, peer.ReasonBoardCgroup},
		{"no children", func(w *world) { w.remove(nodePID) }, peer.ReasonNoChildren},
		{"only a grandchild", func(w *world) {
			w.add(200, proc{comm: "node", ppid: nodePID, start: 1020, uids: all4(appUID), gids: all4(appGID), argv: nodeArgv(), leaf: scope()})
			w.remove(nodePID)
		}, peer.ReasonNoChildren},
		{"a sibling process outside the tree", func(w *world) {
			w.remove(nodePID)
			w.add(300, proc{comm: "node", ppid: 1, start: 1010, uids: all4(appUID), gids: all4(appGID), argv: nodeArgv(), leaf: scope()})
		}, peer.ReasonNoChildren},
		{"process list unreadable", func(w *world) { w.pidsErr = errors.New("no /proc") }, peer.ReasonNoChildren},
		{"foreign uid", func(w *world) { w.set(nodePID, func(p *proc) { p.uids = all4(1234) }) }, peer.ReasonMismatchPrefix + "uid"},
		{"foreign gid", func(w *world) { w.set(nodePID, func(p *proc) { p.gids = all4(1234) }) }, peer.ReasonMismatchPrefix + "gid"},
		{"argv with an extra argument", func(w *world) { w.set(nodePID, func(p *proc) { p.argv = []string{"node", "server.js", "-x"} }) }, peer.ReasonMismatchPrefix + "argv"},
		{"argv shorter", func(w *world) { w.set(nodePID, func(p *proc) { p.argv = []string{"node"} }) }, peer.ReasonMismatchPrefix + "argv"},
		{"argv empty", func(w *world) { w.set(nodePID, func(p *proc) { p.argv = nil }) }, peer.ReasonMismatchPrefix + "argv"},
		{"started before the init", func(w *world) { w.set(nodePID, func(p *proc) { p.start = 999 }) }, peer.ReasonMismatchPrefix + "window"},
		{"started outside the window", func(w *world) { w.set(nodePID, func(p *proc) { p.start = 1501 }) }, peer.ReasonMismatchPrefix + "window"},
		{"another cgroup", func(w *world) {
			w.set(nodePID, func(p *proc) { p.leaf = "docker-" + strings.Repeat("cd", 32) + ".scope" })
		}, peer.ReasonMismatchPrefix + "cgroup"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := newWorld()
			tc.mut(w)
			resolveFails(t, w, tc.reason)
		})
	}
}

func TestResolveEveryIDMustMatch(t *testing.T) {
	// Any one of the four uids (real, effective, saved, fs) or gids that
	// differs refuses the process: a setuid trick must not pass.
	for i := 0; i < 4; i++ {
		i := i
		t.Run("uid", func(t *testing.T) {
			w := newWorld()
			w.set(nodePID, func(p *proc) { p.uids[i] = 0 })
			resolveFails(t, w, peer.ReasonMismatchPrefix+"uid")
		})
		t.Run("gid", func(t *testing.T) {
			w := newWorld()
			w.set(nodePID, func(p *proc) { p.gids[i] = 0 })
			resolveFails(t, w, peer.ReasonMismatchPrefix+"gid")
		})
	}
}

func TestResolveWindowEdge(t *testing.T) {
	w := newWorld()
	w.set(nodePID, func(p *proc) { p.start = 1000 + 500 })
	if pin, _ := resolveOK(t, w); pin.PID != nodePID {
		t.Fatalf("pinned %d", pin.PID)
	}
	w.set(nodePID, func(p *proc) { p.start = 1000 })
	if pin, _ := resolveOK(t, w); pin.PID != nodePID {
		t.Fatalf("pinned %d", pin.PID)
	}
}

func TestResolveSkipsAProcessThatVanishes(t *testing.T) {
	w := newWorld()
	// Listed by Pids, gone by the time it is read.
	w.mu.Lock()
	w.ghosts = []int{400}
	w.mu.Unlock()
	pin, _ := resolveOK(t, w)
	if pin.PID != nodePID {
		t.Fatalf("pinned %d", pin.PID)
	}
}

func TestResolveRestartOfTheBoard(t *testing.T) {
	w := newWorld()
	old, _ := resolveOK(t, w)

	// The board container is recreated: a new id, a new init, a new node.
	newID := strings.Repeat("cd", 32)
	w.remove(tiniPID)
	w.remove(nodePID)
	w.add(500, proc{comm: "tini", ppid: 1, start: 5000, uids: all4(rootUID), gids: all4(rootUID), leaf: "docker-" + newID + ".scope"})
	w.add(501, proc{comm: "node", ppid: 500, start: 5010, uids: all4(appUID), gids: all4(appGID), argv: nodeArgv(), leaf: "docker-" + newID + ".scope"})
	w.setBoard(func(b *peer.BoardState) { b.ID = newID; b.Pid = 500 })

	fresh, _ := resolveOK(t, w)
	if fresh.PID != 501 || fresh.ContainerID != newID {
		t.Fatalf("pin %+v", fresh)
	}
	if old.Same(fresh) {
		t.Fatal("a new container gave the same pin")
	}
}
