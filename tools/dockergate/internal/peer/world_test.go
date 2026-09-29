package peer_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/peer"
)

// The fake /proc: a table of processes and a count of the reads of each pid.

var boardID = strings.Repeat("ab", 32)

const (
	tiniPID = 100
	nodePID = 101
	rootUID = 0
	appUID  = 1000
	appGID  = 1000
)

type proc struct {
	comm       string
	ppid       int
	start      uint64
	uids, gids [4]uint32
	argv       []string
	leaf       string
}

type world struct {
	mu       sync.Mutex
	procs    map[int]proc
	reads    map[int]int
	board    peer.BoardState
	boardErr error
	pidsErr  error
	ghosts   []int
	now      time.Time
}

func all4(v uint32) [4]uint32 { return [4]uint32{v, v, v, v} }

func scope() string { return "docker-" + boardID + ".scope" }

func nodeArgv() []string { return []string{"node", "server.js"} }

// newWorld is a healthy board: a container init (tini) and its first child,
// the node process of the board.
func newWorld() *world {
	return &world{
		procs: map[int]proc{
			tiniPID: {comm: "tini", ppid: 1, start: 1000, uids: all4(rootUID), gids: all4(rootUID), leaf: scope()},
			nodePID: {comm: "node", ppid: tiniPID, start: 1010, uids: all4(appUID), gids: all4(appGID), argv: nodeArgv(), leaf: scope()},
		},
		reads: map[int]int{},
		board: peer.BoardState{
			ID: boardID, Running: true, Pid: tiniPID,
			Labels: map[string]string{"role": "board", "extra": "yes"},
		},
		now: time.Unix(1_800_000_000, 0),
	}
}

func (w *world) caller() config.Caller {
	return config.Caller{
		Container:          "board",
		ContainerLabels:    map[string]string{"role": "board"},
		UID:                appUID,
		GID:                appGID,
		Argv:               nodeArgv(),
		MaxStartDelayTicks: 500,
		Mode:               config.ModeContainerMainProcess,
	}
}

func (w *world) set(pid int, f func(*proc)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	p := w.procs[pid]
	f(&p)
	w.procs[pid] = p
}

func (w *world) add(pid int, p proc) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.procs[pid] = p
}

func (w *world) remove(pid int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.procs, pid)
}

func (w *world) setBoard(f func(*peer.BoardState)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	f(&w.board)
}

func (w *world) readsOf(pid int) int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.reads[pid]
}

func (w *world) get(pid int) (proc, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.reads[pid]++
	p, ok := w.procs[pid]
	if !ok {
		return proc{}, errors.New("no such process")
	}
	return p, nil
}

func (w *world) Pids() ([]int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.pidsErr != nil {
		return nil, w.pidsErr
	}
	pids := append([]int(nil), w.ghosts...)
	for pid := range w.procs {
		pids = append(pids, pid)
	}
	slices.Sort(pids)
	return pids, nil
}

func (w *world) Stat(pid int) (peer.Stat, error) {
	p, err := w.get(pid)
	if err != nil {
		return peer.Stat{}, err
	}
	return peer.Stat{Comm: p.comm, PPid: p.ppid, StartTime: p.start}, nil
}

func (w *world) Status(pid int) (peer.Status, error) {
	p, err := w.get(pid)
	if err != nil {
		return peer.Status{}, err
	}
	return peer.Status{UIDs: p.uids, GIDs: p.gids}, nil
}

func (w *world) Cmdline(pid int) ([]string, error) {
	p, err := w.get(pid)
	if err != nil {
		return nil, err
	}
	return p.argv, nil
}

func (w *world) CgroupLeaf(pid int) (string, error) {
	p, err := w.get(pid)
	if err != nil {
		return "", err
	}
	return p.leaf, nil
}

func (w *world) Board(_ context.Context, container string) (peer.BoardState, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if container != "board" {
		return peer.BoardState{}, errors.New("no such container")
	}
	if w.boardErr != nil {
		return peer.BoardState{}, w.boardErr
	}
	return w.board, nil
}

func (w *world) clock() time.Time {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.now
}

func (w *world) advance(d time.Duration) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.now = w.now.Add(d)
}

func (w *world) resolver() *peer.Resolver {
	return &peer.Resolver{Caller: w.caller(), Board: w, Proc: w, Now: w.clock}
}

func floodConfig() peer.FloodConfig {
	return peer.FloodConfig{
		PerPidRate: 10, PerPidBurst: 20, BanFor: 60 * time.Second,
		GlobalRate: 200, GlobalBurst: 400, MaxTracked: 5000,
	}
}

// newAuth is an Auth over the world; events are the results of its resolves.
func newAuth(w *world) (*peer.Auth, chan peer.ResolveEvent) {
	events := make(chan peer.ResolveEvent, 64)
	a := peer.New(peer.Options{
		Caller:             w.caller(),
		Proc:               w,
		Board:              w,
		Flood:              floodConfig(),
		Now:                w.clock,
		ResolveMinInterval: 2 * time.Second,
		LivenessTTL:        time.Second,
		OnResolve:          func(ev peer.ResolveEvent) { events <- ev },
	})
	return a, events
}

func waitEvent(t *testing.T, ch chan peer.ResolveEvent) peer.ResolveEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(5 * time.Second):
		t.Fatal("no resolve happened")
		return peer.ResolveEvent{}
	}
}

func noEvent(t *testing.T, ch chan peer.ResolveEvent) {
	t.Helper()
	select {
	case ev := <-ch:
		t.Fatalf("an unexpected resolve: %+v", ev)
	case <-time.After(150 * time.Millisecond):
	}
}

func cred(pid int) peer.Cred { return peer.Cred{PID: pid, UID: appUID, GID: appGID} }
