package gate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Histogram buckets of the duration of a request, in seconds (spec 11.3).
var histBuckets = []float64{0.01, 0.1, 1, 10, 60, 125}

// Stats are the counters of dockergate. They hold names of routes and reason
// codes and numbers, never a value from a request or from an answer.
type Stats struct {
	mu sync.Mutex

	allow map[string]uint64
	deny  map[string]map[string]uint64
	hist  map[string][]uint64 // per route: len(histBuckets)+1 counters

	denyPeer       uint64
	upTimeout      uint64
	up5xx          uint64
	markerTooLarge uint64
	rateLimited    uint64

	dockerPing string
}

func newStats() *Stats {
	return &Stats{
		allow: map[string]uint64{},
		deny:  map[string]map[string]uint64{},
		hist:  map[string][]uint64{},
	}
}

func (s *Stats) observe(route string, d time.Duration) {
	h := s.hist[route]
	if h == nil {
		h = make([]uint64, len(histBuckets)+1)
		s.hist[route] = h
	}
	sec := d.Seconds()
	for i, b := range histBuckets {
		if sec <= b {
			h[i]++
			return
		}
	}
	h[len(histBuckets)]++
}

// record counts one decision.
func (s *Stats) record(route, reason string, d time.Duration, upstream5xx bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if reason == "" {
		s.allow[route]++
	} else {
		m := s.deny[route]
		if m == nil {
			m = map[string]uint64{}
			s.deny[route] = m
		}
		m[reason]++
	}
	switch reason {
	case "rate_limited", "concurrency_limited":
		s.rateLimited++
	case "marker_too_large":
		s.markerTooLarge++
	case "upstream_timeout":
		s.upTimeout++
	case "upstream_error", "upstream_upgrade", "response_too_large":
		s.up5xx++
	}
	if upstream5xx {
		s.up5xx++
	}
	s.observe(route, d)
}

func (s *Stats) addDenyPeer() {
	s.mu.Lock()
	s.denyPeer++
	s.mu.Unlock()
}

func (s *Stats) setPing(v string) {
	s.mu.Lock()
	s.dockerPing = v
	s.mu.Unlock()
}

// PinStats is the pin in the stats file.
type PinStats struct {
	Pid   int    `json:"pid"`
	Since string `json:"since"`
}

// UpstreamErrors are the errors of the daemon.
type UpstreamErrors struct {
	Timeout uint64 `json:"timeout"`
	E5xx    uint64 `json:"5xx"`
}

// HistogramStats is the duration histogram of one route.
type HistogramStats struct {
	Le     []float64 `json:"le"`
	Counts []uint64  `json:"counts"`
}

// Snapshot is the content of stats.json.
type Snapshot struct {
	UpdatedAt  string `json:"updatedAt"`
	StartedAt  string `json:"startedAt"`
	Version    string `json:"version"`
	ConfigHash string `json:"configHash"`

	Pinned     bool      `json:"pinned"`
	Pin        *PinStats `json:"pin,omitempty"`
	DockerPing string    `json:"dockerPing"`

	Allow           map[string]uint64            `json:"allow"`
	Deny            map[string]map[string]uint64 `json:"deny"`
	DenyPeer        uint64                       `json:"denyPeer"`
	RejectDropped   uint64                       `json:"rejectDropped"`
	ResolveFailures uint64                       `json:"resolveFailures"`
	ResolveDecoys   uint64                       `json:"resolveDecoys"`
	UpstreamErrors  UpstreamErrors               `json:"upstreamErrors"`
	MarkerTooLarge  uint64                       `json:"markerTooLarge"`
	RateLimited     uint64                       `json:"rateLimited"`

	Inflight int `json:"inflight"`
	Conns    int `json:"conns"`

	Histogram map[string]HistogramStats `json:"histogram"`
}

func (s *Stats) fill(snap *Snapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap.Allow = map[string]uint64{}
	for k, v := range s.allow {
		snap.Allow[k] = v
	}
	snap.Deny = map[string]map[string]uint64{}
	for k, m := range s.deny {
		c := map[string]uint64{}
		for r, n := range m {
			c[r] = n
		}
		snap.Deny[k] = c
	}
	snap.DenyPeer = s.denyPeer
	snap.UpstreamErrors = UpstreamErrors{Timeout: s.upTimeout, E5xx: s.up5xx}
	snap.MarkerTooLarge = s.markerTooLarge
	snap.RateLimited = s.rateLimited
	snap.DockerPing = s.dockerPing
	snap.Histogram = map[string]HistogramStats{}
	routes := make([]string, 0, len(s.hist))
	for r := range s.hist {
		routes = append(routes, r)
	}
	sort.Strings(routes)
	for _, r := range routes {
		snap.Histogram[r] = HistogramStats{Le: histBuckets, Counts: append([]uint64(nil), s.hist[r]...)}
	}
}

// writeFileAtomic writes data to a temporary file in the directory of path and
// renames it over path. The mode is 0644: the monitoring agent reads it.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".stats-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return nil
}

func marshalSnapshot(snap *Snapshot) ([]byte, error) {
	return json.MarshalIndent(snap, "", "  ")
}
