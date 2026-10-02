package gate_test

import (
	"bytes"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fakedocker"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fixture"
)

// The contract (spec 12.3): every request that the real driver sent to a fake
// daemon, replayed in order through the gate against a daemon that keeps the
// state, passes, and every one of them is a route of A1..A12.
func TestContract_RecordedTrafficPasses(t *testing.T) {
	r := newRig(t)
	recs := fixture.Traffic(t)
	if len(recs) == 0 {
		t.Fatal("traffic.json is empty")
	}
	for i, rec := range recs {
		var hdr map[string]string
		for k, v := range rec.Headers {
			if strings.EqualFold(k, "content-type") {
				hdr = map[string]string{"Content-Type": v}
			}
		}
		var body []byte
		if rec.BodyBase64 != "" {
			body = rec.RecordBody(t)
		}
		res := r.send(rec.Method, rec.Target, hdr, body)
		if code := denyCode(res); code != "" {
			t.Errorf("record %d (%s) %s %s: denied (%s), status %d", i, rec.Step, rec.Method, rec.Target, code, res.Status)
		}
	}
	for _, l := range r.decisions() {
		if l.Decision != "allow" {
			t.Errorf("decision %s on %s: %s", l.Decision, l.Route, l.Reason)
		}
		if l.Route == "none" || l.Route == "" {
			t.Errorf("a request outside A1..A12: %+v", l)
		}
	}
}

// RT1-10: the routes that change or read a container act only on containers of
// the bot, in the state that the driver leaves them in (spec 9.1).
func TestRedTeam_RT1_10_Preconditions(t *testing.T) {
	archive := func(r *rig) []byte {
		for _, a := range r.m.Archives {
			if a.MountPath == "/data/hermes" {
				return fixture.ArchiveBytes(t, a)
			}
		}
		t.Fatal("no hermes archive")
		return nil
	}
	nonceOf := func(r *rig) string {
		for _, a := range r.m.Archives {
			if a.MountPath == "/data/hermes" {
				return a.Nonce
			}
		}
		return ""
	}
	cases := []struct {
		name   string
		seed   func(r *rig)
		method string
		target func(r *rig) string
		hdr    map[string]string
		body   func(r *rig) []byte
		code   string
	}{
		{
			name:   "put into a running apply helper",
			seed:   func(r *rig) { r.seedApplyHelper(nonceOf(r), "running") },
			method: "PUT", hdr: tarHdr, body: archive,
			target: func(r *rig) string {
				return r.target(".helper", "/archive?path=%2Fdata%2Fhermes&noOverwriteDirNonDir=true")
			},
			code: deny.StatePrecondition,
		},
		{
			name:   "put into the prepare helper",
			seed:   func(r *rig) { r.seedPrepareHelper("created") },
			method: "PUT", hdr: tarHdr, body: archive,
			target: func(r *rig) string {
				return r.target(".helper", "/archive?path=%2Fdata%2Fhermes&noOverwriteDirNonDir=true")
			},
			code: deny.StatePrecondition,
		},
		{
			name:   "delete of a running main container",
			seed:   func(r *rig) { r.seedMain("running"); r.seedNext("created") },
			method: "DELETE", target: func(r *rig) string { return r.target("", "?force=true&v=true") },
			code: deny.StatePrecondition,
		},
		{
			name:   "delete of the main container without .next",
			seed:   func(r *rig) { r.seedMain("exited") },
			method: "DELETE", target: func(r *rig) string { return r.target("", "?force=true&v=true") },
			code: deny.StatePrecondition,
		},
		{
			name:   "stop without .next",
			seed:   func(r *rig) { r.seedMain("running") },
			method: "POST", target: func(r *rig) string { return r.target("", "/stop?t=30") },
			code: deny.StatePrecondition,
		},
		{
			name:   "stop while .next already runs",
			seed:   func(r *rig) { r.seedMain("running"); r.seedNext("running") },
			method: "POST", target: func(r *rig) string { return r.target("", "/stop?t=30") },
			code: deny.StatePrecondition,
		},
		{
			name:   "rename while the main container exists",
			seed:   func(r *rig) { r.seedMain("exited"); r.seedNext("created") },
			method: "POST",
			target: func(r *rig) string { return r.target(".next", "/rename?name="+r.name("")) },
			code:   deny.StatePrecondition,
		},
		{
			name:   "start of a helper that already ran",
			seed:   func(r *rig) { r.seedApplyHelper(nonceOf(r), "exited") },
			method: "POST", target: func(r *rig) string { return r.target(".helper", "/start") },
			code: deny.StatePrecondition,
		},
		{
			name:   "apply helper without the main container",
			method: "POST", hdr: jsonHdr,
			target: func(r *rig) string { return "/v1.45/containers/create?name=" + r.name(".helper") },
			body: func(r *rig) []byte {
				_, b := r.m.FindBody(t, "helper-apply-"+r.m.Nonces[0], ".helper")
				return b
			},
			code: deny.StatePrecondition,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t)
			if tc.seed != nil {
				tc.seed(r)
			}
			var body []byte
			if tc.body != nil {
				body = tc.body(r)
			}
			res := r.send(tc.method, tc.target(r), tc.hdr, body)
			wantDeny(t, res, tc.code)
			for _, u := range r.uris() {
				if !strings.HasPrefix(u, "GET ") {
					t.Errorf("a changing call reached the daemon: %s", u)
				}
			}
		})
	}
}

// RT1-10: a container that carries the name of a bot but not its label (or the
// label of another bot) is never touched, whatever the route.
func TestRedTeam_RT1_10_ForeignContainer(t *testing.T) {
	other := "00000000-0000-4000-8000-000000000000"
	seeds := map[string]map[string]string{
		"no label":         {},
		"label of another": {"myrmidon.bot": other},
		"helper label":     {"myrmidon.bot-helper": ""},
	}
	routes := []struct {
		name, method, tail string
	}{
		{"inspect", "GET", "/json"},
		{"marker", "GET", "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json"},
		{"start", "POST", "/start"},
		{"restart", "POST", "/restart?t=30"},
		{"delete", "DELETE", "?force=true&v=true"},
	}
	for sname, labels := range seeds {
		for _, rt := range routes {
			t.Run(sname+"/"+rt.name, func(t *testing.T) {
				r := newRig(t)
				l := map[string]string{}
				for k, v := range labels {
					if v == "" {
						v = r.key()
					}
					l[k] = v
				}
				r.d.Seed(fakedocker.Container{Name: r.name(""), ImageID: r.m.ImageID, ImageRef: r.m.Image, Labels: l, Status: "exited"})
				res := r.send(rt.method, r.target("", rt.tail), nil, nil)
				wantDeny(t, res, deny.ForeignContainer)
				for _, u := range r.uris() {
					if !strings.HasPrefix(u, "GET ") {
						t.Errorf("a changing call reached the daemon: %s", u)
					}
				}
			})
		}
	}
}

// Allow side of the precondition of the rename: .next created, main gone.
func TestAllow_Preconditions_RenameAfterDelete(t *testing.T) {
	r := newRig(t)
	r.seedNext("created")
	res := r.send("POST", r.target(".next", "/rename?name="+r.name("")), nil, nil)
	if code := denyCode(res); code != "" || res.Status >= 300 {
		t.Fatalf("rename denied: %d %s", res.Status, res.str())
	}
}

// Resources (spec 9.2, 6.3): the per-bot rate and the size limits of answers.
func TestResources_RateLimited(t *testing.T) {
	r := newRig(t, withConfig(func(c *config.Config) {
		c.Limits.InspectRate, c.Limits.InspectBurst = 0.001, 2
	}))
	r.seedMain("running")
	for i := 0; i < 2; i++ {
		if res := r.send("GET", r.target("", "/json"), nil, nil); res.Status != http.StatusOK {
			t.Fatalf("inspect %d: %d %s", i, res.Status, res.str())
		}
	}
	wantDeny(t, r.send("GET", r.target("", "/json"), nil, nil), deny.RateLimited)
}

func TestResources_RestartRate(t *testing.T) {
	r := newRig(t, withConfig(func(c *config.Config) { c.Limits.RestartPerWindow = 1 }))
	r.seedMain("running")
	if res := r.send("POST", r.target("", "/restart?t=30"), nil, nil); res.Status >= 300 {
		t.Fatalf("first restart: %d %s", res.Status, res.str())
	}
	wantDeny(t, r.send("POST", r.target("", "/restart?t=30"), nil, nil), deny.RateLimited)
	if n := r.count("POST", "/v1.45/containers/"+r.id("")+"/restart"); n != 1 {
		t.Errorf("restarts at the daemon: %d, want 1", n)
	}
}

func TestResources_MarkerTooLargeIsAbsent(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	r.d.Modify(r.name(""), func(c *fakedocker.Container) { c.Marker = bytes.Repeat([]byte{'m'}, 1<<20+1) })
	res := r.send("GET", r.target("", "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json"), nil, nil)
	wantDeny(t, res, deny.MarkerTooLarge)
	if res.Status != http.StatusNotFound {
		t.Errorf("status %d, want 404", res.Status)
	}
}

func TestResources_MarkerWithinLimitPasses(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	r.d.Modify(r.name(""), func(c *fakedocker.Container) { c.Marker = bytes.Repeat([]byte{'m'}, 1<<20-64) })
	res := r.send("GET", r.target("", "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json"), nil, nil)
	if res.Status != http.StatusOK || len(res.Body) != 1<<20-64 {
		t.Fatalf("status %d, %d bytes", res.Status, len(res.Body))
	}
}

func TestResources_LogsTooLarge(t *testing.T) {
	r := newRig(t)
	r.seedApplyHelper(r.m.Nonces[0], "exited")
	r.d.Modify(r.name(".helper"), func(c *fakedocker.Container) { c.Logs = bytes.Repeat([]byte{'l'}, 300<<10) })
	res := r.send("GET", r.target(".helper", "/logs?stdout=true&stderr=true&tail=20"), nil, nil)
	wantDeny(t, res, deny.ResponseTooLarge)
}

func TestResources_InspectTooLarge(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	big := []byte(`{"Id":"` + strings.Repeat("a", 2<<20) + `"}`)
	r.d.SetHook(func(c fakedocker.Call) *fakedocker.Reply {
		if c.Method == "GET" && strings.HasSuffix(c.URI, "/containers/"+r.name("")+"/json") {
			return &fakedocker.Reply{Status: http.StatusOK, Body: big}
		}
		return nil
	})
	res := r.send("GET", r.target("", "/json"), nil, nil)
	wantDeny(t, res, deny.ResponseTooLarge)
}

// Spec 11.3 and acceptance: stats.json carries counters, never values of the
// requests or of the answers of the daemon.
func TestStats_NoValuesOfRequestsOrAnswers(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	r.send("GET", r.target("", "/json"), map[string]string{"Authorization": "Bearer canary-auth-secret"}, nil)
	r.send("GET", "/v1.45/containers/json?canary-query=secret", nil, nil)
	r.send("POST", "/v1.45/containers/create?name="+r.name(""), jsonHdr, []byte(`{"Env":["canary-env=secret"]}`))
	if err := r.g.WriteStats(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(r.cfg.StatsFile)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	for _, bad := range []string{"canary", "secret", "Bearer", r.m.ImageID[7:], "/host/"} {
		if strings.Contains(s, bad) {
			t.Errorf("stats.json carries %q: %s", bad, s)
		}
	}
	if !strings.Contains(s, `"updatedAt"`) || !strings.Contains(s, `"pinned"`) {
		t.Errorf("stats.json lacks the heartbeat fields: %s", s)
	}
}
