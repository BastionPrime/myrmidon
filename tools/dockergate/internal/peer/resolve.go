package peer

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
)

// BoardState is what dockergate needs from an inspect of the board container.
type BoardState struct {
	ID      string
	Running bool
	Pid     int
	Labels  map[string]string
}

// BoardInspector asks the daemon about the board container. It is dockergate's
// own request; a client never influences it.
type BoardInspector interface {
	Board(ctx context.Context, container string) (BoardState, error)
}

// Pin identifies the main process of the board.
type Pin struct {
	PID       int
	StartTime uint64
	// Comm is the command name of the pinned process, for the log only.
	Comm        string
	ContainerID string
	// P0 and S0 are the pid and the starttime of the container's init.
	P0         int
	S0         uint64
	ResolvedAt time.Time
}

// Same reports whether two pins name the same process. The time of the
// resolve does not count: a re-resolve that finds the same process must not
// close the connections of the board.
func (p *Pin) Same(o *Pin) bool {
	if p == nil || o == nil {
		return p == o
	}
	return p.PID == o.PID && p.StartTime == o.StartTime && p.ContainerID == o.ContainerID &&
		p.P0 == o.P0 && p.S0 == o.S0
}

// Decoy is a process that looks like the board's main process in everything
// but its place in the order of starts (spec 4.2, item 5).
type Decoy struct {
	PID  int
	Comm string
	// StartDiff is the starttime of the decoy minus that of the pinned process,
	// in clock ticks.
	StartDiff int64
}

// Reasons of a failed resolve (spec appendix B).
const (
	ReasonBoardNotRunning = "board_not_running"
	ReasonBoardLabels     = "board_labels"
	ReasonBoardCgroup     = "board_cgroup"
	ReasonNoChildren      = "no_children"
	ReasonFirstChildTie   = "first_child_tie"
	// ReasonMismatchPrefix is followed by uid, gid, argv, window or cgroup.
	ReasonMismatchPrefix = "first_child_mismatch:"
)

// ResolveError is a failed resolve: there is no pin.
type ResolveError struct{ Reason string }

func (e *ResolveError) Error() string { return "caller_resolve_failed: " + e.Reason }

func fail(reason string) (*Pin, []Decoy, error) { return nil, nil, &ResolveError{Reason: reason} }

// Resolver finds the main process of the board (spec 4.2).
type Resolver struct {
	Caller config.Caller
	Board  BoardInspector
	Proc   ProcReader
	Now    func() time.Time
}

func (r *Resolver) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// labelsMatch reports whether every configured label is present with the same
// value. The daemon adds labels of its own and of the compose file, so an exact
// comparison of the sets would break with every change of the compose file.
func labelsMatch(want, have map[string]string) bool {
	if len(want) == 0 {
		return false
	}
	for k, v := range want {
		if got, ok := have[k]; !ok || got != v {
			return false
		}
	}
	return true
}

// check runs the checks of step 4 on one process. It returns the failed check
// ("uid", "gid", "argv", "window", "cgroup") or "" when the process passes.
func (r *Resolver) check(pid int, st Stat, s0 uint64, p0Leaf string) string {
	status, err := r.Proc.Status(pid)
	if err != nil {
		return "uid"
	}
	for _, u := range status.UIDs {
		if u != r.Caller.UID {
			return "uid"
		}
	}
	for _, g := range status.GIDs {
		if g != r.Caller.GID {
			return "gid"
		}
	}
	argv, err := r.Proc.Cmdline(pid)
	if err != nil || !slices.Equal(argv, r.Caller.Argv) {
		return "argv"
	}
	if st.StartTime < s0 || st.StartTime-s0 > uint64(r.Caller.MaxStartDelayTicks) {
		return "window"
	}
	leaf, err := r.Proc.CgroupLeaf(pid)
	if err != nil || leaf != p0Leaf {
		return "cgroup"
	}
	return ""
}

// Resolve pins the board's main process. On success it also returns the
// decoys that it saw; on failure the error is a *ResolveError.
func (r *Resolver) Resolve(ctx context.Context) (*Pin, []Decoy, error) {
	board, err := r.Board.Board(ctx, r.Caller.Container)
	if err != nil || !board.Running || board.Pid <= 0 || board.ID == "" {
		return fail(ReasonBoardNotRunning)
	}
	if !labelsMatch(r.Caller.ContainerLabels, board.Labels) {
		return fail(ReasonBoardLabels)
	}
	p0 := board.Pid
	st0, err := r.Proc.Stat(p0)
	if err != nil {
		return fail(ReasonBoardNotRunning)
	}
	leaf0, err := r.Proc.CgroupLeaf(p0)
	if err != nil || leaf0 != "docker-"+board.ID+".scope" {
		return fail(ReasonBoardCgroup)
	}

	pids, err := r.Proc.Pids()
	if err != nil {
		return fail(ReasonNoChildren)
	}
	type child struct {
		pid int
		st  Stat
	}
	var children []child
	for _, pid := range pids {
		st, err := r.Proc.Stat(pid)
		if err != nil {
			continue // the process is gone
		}
		if st.PPid == p0 {
			children = append(children, child{pid, st})
		}
	}
	if len(children) == 0 {
		return fail(ReasonNoChildren)
	}
	slices.SortFunc(children, func(a, b child) int {
		switch {
		case a.st.StartTime < b.st.StartTime:
			return -1
		case a.st.StartTime > b.st.StartTime:
			return 1
		}
		return a.pid - b.pid
	})
	first := children[0]
	if len(children) > 1 && children[1].st.StartTime == first.st.StartTime {
		return fail(ReasonFirstChildTie)
	}
	// Only the first child is considered. If it fails, the next one is not tried:
	// an orphan with a forged argv must not get the pin when the real process
	// stops matching the configuration.
	if bad := r.check(first.pid, first.st, st0.StartTime, leaf0); bad != "" {
		return fail(ReasonMismatchPrefix + bad)
	}

	var decoys []Decoy
	for _, c := range children[1:] {
		if r.check(c.pid, c.st, st0.StartTime, leaf0) == "" {
			decoys = append(decoys, Decoy{
				PID:       c.pid,
				Comm:      c.st.Comm,
				StartDiff: int64(c.st.StartTime) - int64(first.st.StartTime),
			})
		}
	}
	return &Pin{
		PID:         first.pid,
		StartTime:   first.st.StartTime,
		Comm:        first.st.Comm,
		ContainerID: board.ID,
		P0:          p0,
		S0:          st0.StartTime,
		ResolvedAt:  r.now(),
	}, decoys, nil
}

// IsResolveError extracts the reason of a failed resolve.
func IsResolveError(err error) (string, bool) {
	var re *ResolveError
	if errors.As(err, &re) {
		return re.Reason, true
	}
	return "", false
}
