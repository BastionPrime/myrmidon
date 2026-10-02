package peer

import (
	"sort"
	"sync"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/limit"
)

// FloodConfig is the flood defence of the listener (spec 4.3).
type FloodConfig struct {
	PerPidRate  float64
	PerPidBurst float64
	BanFor      time.Duration
	GlobalRate  float64
	GlobalBurst float64
	// MaxTracked bounds the table of pids. When it is full, a pid that is not in
	// it is dropped without an answer.
	MaxTracked int
}

const (
	defaultMaxTracked = 65536
	aggregateCap      = 1024
	sweepEvery        = 10 * time.Second
	idleAfter         = time.Minute
	floodReportEvery  = time.Minute
)

type floodEntry struct {
	bucket   *limit.Bucket
	banUntil time.Time
}

// Aggregate is one line of the aggregated log of refused callers.
type Aggregate struct {
	PID   int
	Comm  string
	Count uint64
}

// Flood decides, for a connection of a foreign caller, whether it gets the
// static 403 or is closed without an answer. It never applies to the pinned
// pid: the caller of Admit does not ask it about that pid.
type Flood struct {
	mu     sync.Mutex
	cfg    FloodConfig
	now    func() time.Time
	global *limit.Bucket
	pids   map[int]*floodEntry
	sweep  time.Time

	replied uint64
	dropped uint64

	agg         map[int]uint64
	aggOverflow uint64

	reportAt      time.Time
	reportedDrops uint64
}

// NewFlood returns a flood defence. now may be nil for the wall clock.
func NewFlood(cfg FloodConfig, now func() time.Time) *Flood {
	if now == nil {
		now = time.Now
	}
	if cfg.MaxTracked <= 0 {
		cfg.MaxTracked = defaultMaxTracked
	}
	t := now()
	return &Flood{
		cfg:    cfg,
		now:    now,
		global: limit.New(cfg.GlobalRate, cfg.GlobalBurst, t),
		pids:   map[int]*floodEntry{},
		sweep:  t,
		agg:    map[int]uint64{},
	}
}

// Admit reports whether a connection of a foreign pid may get the static
// answer. false means: close it silently.
func (f *Flood) Admit(pid int) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	f.sweepLocked(now)

	e, ok := f.pids[pid]
	if ok && now.Before(e.banUntil) {
		f.dropped++
		return false
	}
	if !ok {
		if len(f.pids) >= f.cfg.MaxTracked {
			f.dropped++
			return false
		}
		e = &floodEntry{bucket: limit.New(f.cfg.PerPidRate, f.cfg.PerPidBurst, now)}
		f.pids[pid] = e
	} else if !e.banUntil.IsZero() {
		// The ban is over: the pid starts again with a full bucket.
		e.banUntil = time.Time{}
		e.bucket = limit.New(f.cfg.PerPidRate, f.cfg.PerPidBurst, now)
	}
	if !e.bucket.Allow(now) {
		e.banUntil = now.Add(f.cfg.BanFor)
		f.dropped++
		return false
	}
	if !f.global.Allow(now) {
		f.dropped++
		return false
	}
	f.replied++
	if _, seen := f.agg[pid]; seen || len(f.agg) < aggregateCap {
		f.agg[pid]++
	} else {
		f.aggOverflow++
	}
	return true
}

// sweepLocked forgets pids that have been quiet for a while, so that a caller
// that forks a new pid per connection cannot grow the table without bound.
func (f *Flood) sweepLocked(now time.Time) {
	if now.Sub(f.sweep) < sweepEvery {
		return
	}
	f.sweep = now
	for pid, e := range f.pids {
		if now.Before(e.banUntil) {
			continue
		}
		if now.Sub(e.bucket.Last()) > idleAfter {
			delete(f.pids, pid)
		}
	}
}

// Replied is the number of static answers given to foreign callers.
func (f *Flood) Replied() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.replied
}

// Dropped is the number of connections closed silently.
func (f *Flood) Dropped() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dropped
}

// Banned is the number of pids that are banned now.
func (f *Flood) Banned() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	n := 0
	for _, e := range f.pids {
		if now.Before(e.banUntil) {
			n++
		}
	}
	return n
}

// TakeReport returns the number of silently closed connections since the last
// report, at most once a minute, and only when there were some. It is the source
// of the reject_flood log line.
func (f *Flood) TakeReport() (dropped uint64, ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	if f.dropped == f.reportedDrops {
		return 0, false
	}
	if !f.reportAt.IsZero() && now.Sub(f.reportAt) < floodReportEvery {
		return 0, false
	}
	f.reportAt = now
	delta := f.dropped - f.reportedDrops
	f.reportedDrops = f.dropped
	return delta, true
}

// Flush returns the refused callers since the last flush, the busiest first, at
// most top of them, and forgets them. The command name is looked up here and
// only here, and only for the pids that are returned.
func (f *Flood) Flush(proc ProcReader, top int) (list []Aggregate, others uint64) {
	f.mu.Lock()
	agg := f.agg
	others = f.aggOverflow
	f.agg = map[int]uint64{}
	f.aggOverflow = 0
	f.mu.Unlock()

	for pid, n := range agg {
		list = append(list, Aggregate{PID: pid, Count: n})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Count != list[j].Count {
			return list[i].Count > list[j].Count
		}
		return list[i].PID < list[j].PID
	})
	if len(list) > top {
		for _, a := range list[top:] {
			others += a.Count
		}
		list = list[:top]
	}
	for i := range list {
		if proc != nil && list[i].PID > 0 {
			if st, err := proc.Stat(list[i].PID); err == nil {
				list[i].Comm = st.Comm
			}
		}
	}
	return list, others
}
