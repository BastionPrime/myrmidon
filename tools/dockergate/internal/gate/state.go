package gate

import (
	"context"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/limit"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
)

// botState is what dockergate keeps per enrolled bot: the lock of the mutating
// routes and the buckets of the rates (spec 9.2).
type botState struct {
	lock chan struct{}

	inspect, create, start, restart, stop, put *limit.Bucket
}

// Kinds of the per-bot rate.
type rateKind int

const (
	rateInspect rateKind = iota + 1
	rateCreate
	rateStart
	rateRestart
	rateStop
	ratePut
)

func (g *Gate) bot(key string, lim config.Limits) *botState {
	g.mu.Lock()
	defer g.mu.Unlock()
	b := g.bots[key]
	if b != nil {
		return b
	}
	now := g.now()
	w := config.Sec(lim.RateWindowSec)
	b = &botState{
		lock:    make(chan struct{}, 1),
		inspect: limit.New(lim.InspectRate, lim.InspectBurst, now),
		create:  limit.PerWindow(lim.CreatePerWindow, w, now),
		start:   limit.PerWindow(lim.StartPerWindow, w, now),
		restart: limit.PerWindow(lim.RestartPerWindow, w, now),
		stop:    limit.PerWindow(lim.StopPerWindow, w, now),
		put:     limit.PerWindow(lim.PutPerWindow, w, now),
	}
	g.bots[key] = b
	return b
}

// allow takes a token of the given rate.
func (g *Gate) allow(b *botState, k rateKind) *deny.Error {
	var bucket *limit.Bucket
	switch k {
	case rateInspect:
		bucket = b.inspect
	case rateCreate:
		bucket = b.create
	case rateStart:
		bucket = b.start
	case rateRestart:
		bucket = b.restart
	case rateStop:
		bucket = b.stop
	case ratePut:
		bucket = b.put
	}
	if bucket == nil || !bucket.Allow(g.now()) {
		return deny.New(deny.RateLimited)
	}
	return nil
}

// acquire takes a slot of the upstream concurrency limit.
func (g *Gate) acquire() (release func(), ok bool) {
	select {
	case g.sem <- struct{}{}:
		return func() { <-g.sem }, true
	default:
		return nil, false
	}
}

// lockBot takes the lock of a bot. The wait ends when the client goes away or
// after lockWait.
func (g *Gate) lockBot(ctx context.Context, b *botState) (unlock func(), derr *deny.Error) {
	t := time.NewTimer(g.lockWait)
	defer t.Stop()
	select {
	case b.lock <- struct{}{}:
		return func() { <-b.lock }, nil
	case <-ctx.Done():
		return nil, deny.New(deny.UpstreamError).WithDetail("canceled")
	case <-t.C:
		return nil, deny.New(deny.ConcurrencyLimited).WithDetail("lock")
	}
}

// imageByID finds the allowed image with this Id. The Ids are cached; a miss
// re-reads all of them from the daemon (at most once per refreshMinInterval).
func (g *Gate) imageByID(ctx context.Context, st *runtime, id string) (*policy.ImageInfo, *deny.Error) {
	g.imgMu.Lock()
	e, ok := g.imgs[id]
	g.imgMu.Unlock()
	if ok {
		if _, allowed := st.set[e.ref]; allowed {
			return e.info, nil
		}
	}

	g.imgMu.Lock()
	recent := !g.imgRefreshAt.IsZero() && g.now().Sub(g.imgRefreshAt) < refreshMinInterval
	g.imgMu.Unlock()
	if recent {
		return nil, nil
	}

	fresh := map[string]imageEntry{}
	for _, ref := range st.cfg.Images {
		info, _, derr := g.up.InspectImage(ctx, route.NameSegment(ref))
		if derr != nil {
			return nil, derr
		}
		if info == nil {
			continue
		}
		fresh[info.ID] = imageEntry{ref: ref, info: info}
	}
	g.imgMu.Lock()
	g.imgs = fresh
	g.imgRefreshAt = g.now()
	g.imgMu.Unlock()
	if e, ok := fresh[id]; ok {
		return e.info, nil
	}
	return nil, nil
}
