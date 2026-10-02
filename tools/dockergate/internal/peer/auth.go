package peer

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// Verdict is what the listener does with a new connection.
type Verdict int

const (
	// Accept serves the connection.
	Accept Verdict = iota
	// Reply writes the static 403 (Decision.Code) and closes.
	Reply
	// Drop closes the connection without an answer.
	Drop
)

// Decision is the result of Auth.Admit.
type Decision struct {
	Verdict Verdict
	// Code is the reason code of a Reply: caller_not_board_main or
	// caller_resolve_failed.
	Code string
	Cred Cred
	// Pin is the pin an accepted connection is bound to.
	Pin *Pin
}

// ResolveEvent is reported after every resolve.
type ResolveEvent struct {
	Pin *Pin
	// Reason is the reason of a failure; empty on success.
	Reason string
	Decoys []Decoy
	// Changed is true when the pin is not the one that was there before.
	Changed bool
}

// Options configure an Auth.
type Options struct {
	Caller config.Caller
	Proc   ProcReader
	Board  BoardInspector
	// Cred reads the peer credentials; SoCred when nil.
	Cred  CredFunc
	Flood FloodConfig
	Now   func() time.Time
	// ResolveMinInterval is the shortest time between two resolves that a
	// connection may start. Default 2 s.
	ResolveMinInterval time.Duration
	// LivenessTTL is how long the answer "the pinned process is alive" is
	// reused at accept. Default 1 s.
	LivenessTTL time.Duration
	// OnResolve is called after every resolve, on the goroutine that ran it.
	OnResolve func(ResolveEvent)
}

// uidPin is the pin of the uid mode, which has no process to pin.
var uidPin = &Pin{}

// Auth authenticates the callers of the socket.
type Auth struct {
	opt      Options
	resolver *Resolver
	flood    *Flood

	mu        sync.Mutex
	pin       *Pin
	lastKick  time.Time
	liveAt    time.Time
	resolveMu sync.Mutex

	resolveFailures atomic.Uint64
	resolveDecoys   atomic.Uint64
}

// New returns an Auth. It has no pin until Resolve succeeds.
func New(opt Options) *Auth {
	if opt.Cred == nil {
		opt.Cred = SoCred
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.ResolveMinInterval <= 0 {
		opt.ResolveMinInterval = 2 * time.Second
	}
	if opt.LivenessTTL <= 0 {
		opt.LivenessTTL = time.Second
	}
	return &Auth{
		opt:      opt,
		resolver: &Resolver{Caller: opt.Caller, Board: opt.Board, Proc: opt.Proc, Now: opt.Now},
		flood:    NewFlood(opt.Flood, opt.Now),
	}
}

// Flood exposes the flood defence for the counters and the log.
func (a *Auth) Flood() *Flood { return a.flood }

// Pinned returns the current pin, nil when there is none. In the uid mode it
// returns a placeholder.
func (a *Auth) Pinned() *Pin {
	if a.opt.Caller.Mode == config.ModeUID {
		return uidPin
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.pin
}

// ResolveFailures and ResolveDecoys are the counters of the stats.
func (a *Auth) ResolveFailures() uint64 { return a.resolveFailures.Load() }
func (a *Auth) ResolveDecoys() uint64   { return a.resolveDecoys.Load() }

// Resolve pins the board's main process now. It is called at start and by the
// heartbeat; connections use Kick.
func (a *Auth) Resolve(ctx context.Context) error {
	if a.opt.Caller.Mode == config.ModeUID {
		return nil
	}
	a.resolveMu.Lock()
	defer a.resolveMu.Unlock()
	return a.resolveLocked(ctx)
}

func (a *Auth) resolveLocked(ctx context.Context) error {
	pin, decoys, err := a.resolver.Resolve(ctx)
	a.mu.Lock()
	old := a.pin
	ev := ResolveEvent{Pin: pin, Decoys: decoys}
	if err != nil {
		a.pin = nil
		ev.Reason, _ = IsResolveError(err)
		ev.Changed = old != nil
	} else {
		ev.Changed = !pin.Same(old)
		if !ev.Changed {
			// The same process: the pin keeps its time, so that "since" of the
			// stats is the time of the first resolve of this process.
			pin = old
			ev.Pin = old
		}
		a.pin = pin
		a.liveAt = a.opt.Now()
	}
	a.mu.Unlock()
	if err != nil {
		a.resolveFailures.Add(1)
	}
	a.resolveDecoys.Add(uint64(len(decoys)))
	if a.opt.OnResolve != nil {
		a.opt.OnResolve(ev)
	}
	return err
}

// Kick starts a resolve in the background, at most once per ResolveMinInterval
// and never two at once. It is what a connection without a pin causes.
func (a *Auth) Kick() {
	if a.opt.Caller.Mode == config.ModeUID {
		return
	}
	now := a.opt.Now()
	a.mu.Lock()
	if !a.lastKick.IsZero() && now.Sub(a.lastKick) < a.opt.ResolveMinInterval {
		a.mu.Unlock()
		return
	}
	a.lastKick = now
	a.mu.Unlock()
	if !a.resolveMu.TryLock() {
		return
	}
	go func() {
		defer a.resolveMu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = a.resolveLocked(ctx)
	}()
}

// alive reads the pinned process, and only it: the process is alive and has the
// starttime of the pin.
func (a *Auth) alive(pin *Pin) bool {
	st, err := a.opt.Proc.Stat(pin.PID)
	return err == nil && st.StartTime == pin.StartTime
}

// drop forgets the pin if it is still the given one.
func (a *Auth) drop(pin *Pin) {
	a.mu.Lock()
	if a.pin != nil && a.pin.Same(pin) {
		a.pin = nil
	}
	a.mu.Unlock()
}

// Valid is the check of every request of an accepted connection: the pin of
// the connection is still the current one, and the pinned process is alive and
// has not been replaced by a process with the same pid.
func (a *Auth) Valid(pin *Pin) bool {
	if a.opt.Caller.Mode == config.ModeUID {
		return true
	}
	a.mu.Lock()
	cur := a.pin
	a.mu.Unlock()
	if cur == nil || !cur.Same(pin) {
		return false
	}
	if !a.alive(cur) {
		a.drop(cur)
		return false
	}
	return true
}

// Admit decides about a new connection, before a byte of it is read.
func (a *Auth) Admit(c net.Conn) Decision {
	cred, err := a.opt.Cred(c)
	if err != nil {
		// No credentials: no way to tell who it is. It is refused like any
		// foreign caller, and counted under pid 0.
		cred = Cred{PID: 0, UID: ^uint32(0), GID: ^uint32(0)}
	}
	return a.AdmitCred(cred)
}

// AdmitCred is Admit for known credentials.
func (a *Auth) AdmitCred(cred Cred) Decision {
	d := Decision{Cred: cred}
	right := cred.PID > 0 && cred.UID == a.opt.Caller.UID && cred.GID == a.opt.Caller.GID

	if a.opt.Caller.Mode == config.ModeUID {
		if right {
			d.Pin = uidPin
			return d
		}
		return a.foreign(d, deny.CallerNotBoardMain)
	}

	a.mu.Lock()
	pin := a.pin
	a.mu.Unlock()

	if pin != nil && right && cred.PID == pin.PID {
		// The pinned pid: the only one whose /proc entry is read here.
		if a.alive(pin) {
			d.Pin = pin
			return d
		}
		a.drop(pin)
		a.Kick()
		d.Verdict = Reply
		d.Code = deny.CallerNotBoardMain
		return a.foreignAdmit(d)
	}

	if pin != nil && !a.pinAliveCached(pin) {
		a.drop(pin)
		pin = nil
	}
	if pin == nil {
		a.Kick()
		return a.foreign(d, deny.CallerResolveFailed)
	}
	return a.foreign(d, deny.CallerNotBoardMain)
}

// pinAliveCached is the liveness of the pinned process for a foreign
// connection: one read of the pinned pid per LivenessTTL, never of the foreign
// pid.
func (a *Auth) pinAliveCached(pin *Pin) bool {
	now := a.opt.Now()
	a.mu.Lock()
	fresh := !a.liveAt.IsZero() && now.Sub(a.liveAt) < a.opt.LivenessTTL
	a.mu.Unlock()
	if fresh {
		return true
	}
	ok := a.alive(pin)
	if ok {
		a.mu.Lock()
		a.liveAt = now
		a.mu.Unlock()
	}
	return ok
}

func (a *Auth) foreign(d Decision, code string) Decision {
	d.Code = code
	return a.foreignAdmit(d)
}

func (a *Auth) foreignAdmit(d Decision) Decision {
	if a.flood.Admit(d.Cred.PID) {
		d.Verdict = Reply
	} else {
		d.Verdict = Drop
	}
	return d
}

// Tick is the heartbeat of the pin (every 15 s): it resolves when there is no
// pin, when the board container has another main pid, or when the pinned
// process is gone. An error of the daemon keeps the pin that there is.
func (a *Auth) Tick(ctx context.Context) {
	if a.opt.Caller.Mode == config.ModeUID {
		return
	}
	a.mu.Lock()
	pin := a.pin
	a.mu.Unlock()
	if pin != nil && a.alive(pin) {
		b, err := a.opt.Board.Board(ctx, a.opt.Caller.Container)
		if err != nil {
			return
		}
		if b.Running && b.Pid == pin.P0 && b.ID == pin.ContainerID {
			return
		}
	}
	_ = a.Resolve(ctx)
}
