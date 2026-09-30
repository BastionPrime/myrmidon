// Package gate is the server of dockergate: it authenticates the caller, matches
// the request against the allowlist, checks and rebuilds the body, checks the
// state of the containers, and only then calls the daemon with a request that it
// has built itself.
package gate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"reflect"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/limit"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/peer"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/upstream"
)

// Limits of the answers (spec 6.3 and 11.1).
const (
	maxErrBody   = 64 << 10
	maxInspectA  = 1 << 20
	maxMarker    = 1 << 20
	maxLogsBody  = 256 << 10
	maxCreateRes = 64 << 10
	maxWaitBody  = 64 << 10

	statsEvery   = 15 * time.Second
	callersEvery = 60 * time.Second
	floodEvery   = 5 * time.Second
	// refreshMinInterval is the shortest time between two re-reads of the
	// image Ids that a miss can cause.
	refreshMinInterval = time.Second
)

var idRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// runtime is the part of the configuration that a reload replaces.
type runtime struct {
	cfg    *config.Config
	hash   string
	images route.Images
	set    map[string]struct{}
}

func newRuntime(cfg *config.Config, hash string) *runtime {
	set := make(map[string]struct{}, len(cfg.Images))
	for _, im := range cfg.Images {
		set[im] = struct{}{}
	}
	return &runtime{cfg: cfg, hash: hash, images: route.NewImages(cfg.Images), set: set}
}

// Options configure a Gate. Everything but Cfg has a default.
type Options struct {
	Cfg        *config.Config
	ConfigHash string
	// ConfigPath is the file that SIGHUP re-reads; empty disables the reload.
	ConfigPath string
	Version    string
	// Log receives one JSON line per decision. Nil discards.
	Log  io.Writer
	Proc peer.ProcReader
	Cred peer.CredFunc
	// Lstat is how the volume root is looked at; tests replace it.
	Lstat policy.LstatFunc
	Now   func() time.Time
}

// Gate is the dockergate server.
type Gate struct {
	opt     Options
	up      *upstream.Client
	auth    *peer.Auth
	log     *Logger
	stats   *Stats
	now     func() time.Time
	lstat   policy.LstatFunc
	started time.Time

	st atomic.Pointer[runtime]

	global   *limit.Bucket
	sem      chan struct{}
	replySem chan struct{}
	conns    atomic.Int64
	connSeq  atomic.Uint64
	lockWait time.Duration

	mu   sync.Mutex
	bots map[string]*botState

	imgMu        sync.Mutex
	imgs         map[string]imageEntry
	imgRefreshAt time.Time

	resolveMu     sync.Mutex
	resolveReason string
	resolveLogAt  time.Time
}

type imageEntry struct {
	ref  string
	info *policy.ImageInfo
}

// New builds a Gate. It does not touch the network.
func New(opt Options) (*Gate, error) {
	if opt.Cfg == nil || opt.Cfg.Caller == nil {
		return nil, errors.New("gate: no configuration")
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Proc == nil {
		opt.Proc = peer.OSProc{}
	}
	if opt.Lstat == nil {
		opt.Lstat = policy.OSLstat
	}
	cfg := opt.Cfg
	lim := cfg.Limits
	g := &Gate{
		opt:      opt,
		now:      opt.Now,
		lstat:    opt.Lstat,
		started:  opt.Now(),
		log:      NewLogger(opt.Log, opt.Now),
		stats:    newStats(),
		up:       upstream.New(cfg.Upstream, config.Sec(lim.IdleConnTimeoutSec)),
		global:   limit.New(lim.GlobalRate, lim.GlobalBurst, opt.Now()),
		sem:      make(chan struct{}, lim.MaxInflightUpstream),
		replySem: make(chan struct{}, 32),
		lockWait: config.Sec(lim.UpstreamStopSec) + 5*time.Second,
		bots:     map[string]*botState{},
	}
	g.st.Store(newRuntime(cfg, opt.ConfigHash))
	g.auth = peer.New(peer.Options{
		Caller: *cfg.Caller,
		Proc:   opt.Proc,
		Board:  g.up,
		Cred:   opt.Cred,
		Now:    opt.Now,
		Flood: peer.FloodConfig{
			PerPidRate:  lim.RejectPerPidRate,
			PerPidBurst: lim.RejectPerPidBurst,
			BanFor:      config.Sec(lim.RejectBanSec),
			GlobalRate:  lim.RejectGlobalRate,
			GlobalBurst: lim.RejectGlobalBurst,
		},
		ResolveMinInterval: config.Sec(lim.ResolveMinIntervalSec),
		OnResolve:          g.onResolve,
	})
	return g, nil
}

// Auth exposes the authentication for the tests and the heartbeat.
func (g *Gate) Auth() *peer.Auth { return g.auth }

// Close drops the idle connections to the daemon.
func (g *Gate) Close() { g.up.Close() }

// SelfCheck is the check at start: the daemon speaks the API version, the
// images are there and meet the contract, and the board is pinned. A wrong API
// version or an unreachable daemon is an error; a missing image or an unpinned
// board is only logged (the board may start later).
func (g *Gate) SelfCheck(ctx context.Context) error {
	st := g.st.Load()
	v, err := g.up.Version(ctx)
	if err != nil {
		return fmt.Errorf("self-check: the daemon does not answer: %w", err)
	}
	if !v.SupportsAPI(config.SupportedAPIVersion) {
		return fmt.Errorf("self-check: the daemon does not speak API %s (has %s..%s)",
			config.SupportedAPIVersion, v.MinAPIVersion, v.APIVersion)
	}
	found := 0
	for _, ref := range st.cfg.Images {
		info, _, derr := g.up.InspectImage(ctx, route.NameSegment(ref))
		if derr != nil || info == nil {
			g.log.Write(Line{Level: LevelWarn, Event: "self-check.image_missing"})
			continue
		}
		found++
		if cerr := policy.CheckImage(info); cerr != nil {
			g.log.Write(Line{Level: LevelWarn, Event: "self-check.image_contract", Reason: cerr.Code, Detail: cerr.Detail})
		}
	}
	_ = g.auth.Resolve(ctx)
	pinned := g.auth.Pinned() != nil
	g.log.Write(Line{Event: "self-check ok", Version: g.opt.Version, API: v.APIVersion, Images: found, Pinned: &pinned})
	return nil
}

// onResolve logs the result of a resolve of the pin.
func (g *Gate) onResolve(ev peer.ResolveEvent) {
	for _, d := range ev.Decoys {
		g.log.Write(Line{Level: LevelError, Event: "caller_decoy", Pid: d.PID, Comm: d.Comm, Diff: d.StartDiff})
	}
	if ev.Reason != "" {
		g.resolveMu.Lock()
		now := g.now()
		quiet := ev.Reason == g.resolveReason && now.Sub(g.resolveLogAt) < callersEvery
		if !quiet {
			g.resolveReason = ev.Reason
			g.resolveLogAt = now
		}
		g.resolveMu.Unlock()
		if !quiet {
			g.log.Write(Line{Level: LevelError, Event: "caller_resolve_failed", Reason: ev.Reason})
		}
		return
	}
	g.resolveMu.Lock()
	g.resolveReason = ""
	g.resolveMu.Unlock()
	if ev.Changed && ev.Pin != nil {
		g.log.Write(Line{Event: "caller_pinned", Pid: ev.Pin.PID, Comm: ev.Pin.Comm})
	}
}

// reloadable reports whether a new configuration differs from the running one
// only in what a SIGHUP may change: bots, images, network, volumeRoot and the
// allowed extra mount sources. The rest needs a restart.
func reloadable(old, cur *config.Config) bool {
	return old.Listen == cur.Listen && old.Upstream == cur.Upstream &&
		old.APIVersion == cur.APIVersion && old.StatsFile == cur.StatsFile &&
		old.Limits == cur.Limits && reflect.DeepEqual(old.Caller, cur.Caller)
}

// Reload re-reads the configuration file. An invalid file, or one that changes
// what needs a restart, is not applied: the running configuration stays and a
// config_reload_failed line is logged.
func (g *Gate) Reload() {
	if g.opt.ConfigPath == "" {
		return
	}
	cfg, hash, err := config.Load(g.opt.ConfigPath)
	if err != nil {
		g.log.Write(Line{Level: LevelError, Event: "config_reload_failed", Detail: "invalid"})
		return
	}
	if !reloadable(g.st.Load().cfg, cfg) {
		g.log.Write(Line{Level: LevelError, Event: "config_reload_failed", Detail: "restart_required"})
		return
	}
	g.st.Store(newRuntime(cfg, hash))
	g.imgMu.Lock()
	g.imgs = nil
	g.imgMu.Unlock()
	g.log.Write(Line{Event: "config_reloaded"})
}

// Listen creates the socket of dockergate: an old socket file is removed, the
// new one gets mode 0666 (the directory around it is what keeps others out,
// and every connection is authenticated by SO_PEERCRED anyway).
func (g *Gate) Listen() (net.Listener, error) {
	path := g.st.Load().cfg.Listen
	if fi, err := os.Lstat(path); err == nil {
		if fi.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("listen: %s exists and is not a socket", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o666); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

// Serve serves ln until ctx is done. It also runs the heartbeat of the pin, the
// writer of stats.json and the flusher of the aggregated log.
func (g *Gate) Serve(ctx context.Context, ln net.Listener) error {
	lim := g.st.Load().cfg.Limits
	var protos http.Protocols
	protos.SetHTTP1(true)
	srv := &http.Server{
		Handler: g,
		// "OPTIONS *" is answered by net/http itself unless this is set; every
		// request, that one too, goes through the gate and gets its decision.
		DisableGeneralOptionsHandler: true,
		ReadHeaderTimeout:            config.Sec(lim.ReadHeaderTimeoutSec),
		IdleTimeout:                  config.Sec(lim.IdleConnTimeoutSec),
		MaxHeaderBytes:               lim.MaxHeaderBytes,
		Protocols:                    &protos,
		ErrorLog:                     log.New(io.Discard, "", 0),
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			if ac, ok := c.(*authConn); ok {
				return context.WithValue(ctx, connKey{}, ac.info)
			}
			return ctx
		},
	}

	loops, stop := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); g.heartbeatLoop(loops, config.Sec(lim.ResolvePollSec)) }()
	go func() { defer wg.Done(); g.statsLoop(loops) }()
	go func() { defer wg.Done(); g.callersLoop(loops) }()
	defer func() { stop(); wg.Wait() }()

	done := make(chan error, 1)
	go func() { done <- srv.Serve(&listener{g: g, ln: ln}) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(sctx); err != nil {
			_ = srv.Close()
		}
		<-done
		return nil
	}
}

func (g *Gate) heartbeatLoop(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		g.Heartbeat(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Heartbeat is one beat: the pin is kept (or found), and the daemon is pinged
// for the stats.
func (g *Gate) Heartbeat(ctx context.Context) {
	g.auth.Tick(ctx)
	pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := g.up.Ping(pctx); err != nil {
		g.stats.setPing("error")
	} else {
		g.stats.setPing("ok")
	}
}

func (g *Gate) statsLoop(ctx context.Context) {
	t := time.NewTicker(statsEvery)
	defer t.Stop()
	for {
		// The file is written whatever the state: a stale file is the alarm.
		if err := g.WriteStats(); err != nil {
			g.log.Write(Line{Level: LevelError, Event: "stats_write_failed"})
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (g *Gate) callersLoop(ctx context.Context) {
	agg := time.NewTicker(callersEvery)
	fl := time.NewTicker(floodEvery)
	defer agg.Stop()
	defer fl.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-agg.C:
			g.FlushCallers()
		case <-fl.C:
			g.ReportFlood()
		}
	}
}

// FlushCallers writes the aggregated log of refused callers: one line per
// minute, the busiest first.
func (g *Gate) FlushCallers() {
	list, others := g.auth.Flood().Flush(g.opt.Proc, 10)
	if len(list) == 0 && others == 0 {
		return
	}
	rows := make([]CallerRow, 0, len(list))
	var total uint64
	for _, a := range list {
		rows = append(rows, CallerRow{Pid: a.PID, Comm: a.Comm, Count: a.Count})
		total += a.Count
	}
	g.log.Write(Line{Level: LevelWarn, Event: deny.CallerNotBoardMain, Count: total + others, Others: others, Callers: rows})
}

// ReportFlood writes reject_flood when connections were closed silently since
// the last report.
func (g *Gate) ReportFlood() {
	if n, ok := g.auth.Flood().TakeReport(); ok {
		g.log.Write(Line{Level: LevelError, Event: "reject_flood", Count: n})
	}
}

// Snapshot returns the content of stats.json.
func (g *Gate) Snapshot() *Snapshot {
	st := g.st.Load()
	snap := &Snapshot{
		UpdatedAt:  g.now().UTC().Format(time.RFC3339),
		StartedAt:  g.started.UTC().Format(time.RFC3339),
		Version:    g.opt.Version,
		ConfigHash: st.hash,
	}
	if pin := g.auth.Pinned(); pin != nil {
		snap.Pinned = true
		if pin.PID > 0 {
			snap.Pin = &PinStats{Pid: pin.PID, Since: pin.ResolvedAt.UTC().Format(time.RFC3339)}
		}
	}
	snap.RejectDropped = g.auth.Flood().Dropped()
	snap.ResolveFailures = g.auth.ResolveFailures()
	snap.ResolveDecoys = g.auth.ResolveDecoys()
	snap.Inflight = len(g.sem)
	snap.Conns = int(g.conns.Load())
	g.stats.fill(snap)
	return snap
}

// WriteStats rewrites stats.json atomically.
func (g *Gate) WriteStats() error {
	data, err := marshalSnapshot(g.Snapshot())
	if err != nil {
		return err
	}
	return writeFileAtomic(g.st.Load().cfg.StatsFile, data)
}
