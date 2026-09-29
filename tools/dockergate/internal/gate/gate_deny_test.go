package gate_test

import (
	"bytes"
	"fmt"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fixture"
)

// The deny side of the wire: what the gate does with every request that is not
// on the allowlist, at the level of the HTTP connection. The daemon behind the
// gate must see nothing of any of them.

const (
	pfx = "/v1.45"
	// otherKey is a well-formed K that is not enrolled.
	otherKey = "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff"
)

// mustClose are the denials after which the connection is closed.
var mustClose = map[string]bool{
	deny.HeaderForbidden: true,
	deny.BodyNotAllowed:  true,
	deny.TargetForm:      true,
	deny.ContentType:     true,
	deny.BodyTooLarge:    true,
	deny.TarTooLarge:     true,
}

// wantClosed checks that the gate closed the connection: no more answers, and
// not a silent hang.
func (c *client) wantClosed() {
	c.t.Helper()
	_ = c.c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, err := c.br.Peek(1)
	if err == nil {
		c.t.Errorf("more data on a connection that must be closed")
		return
	}
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		c.t.Errorf("the connection was left open")
	}
}

// wantDenyOneOf is wantDeny for a request that may be refused for more than one
// reason.
func wantDenyOneOf(t testing.TB, res *resp, codes ...string) {
	t.Helper()
	got := denyCode(res)
	for _, c := range codes {
		if got == c {
			wantDeny(t, res, c)
			return
		}
	}
	t.Errorf("reason %q, want one of %v; status %d, body %q", got, codes, res.Status, res.str())
}

type denyCase struct {
	method string
	target string
	hdr    map[string]string
	body   []byte
	code   string
	// plain400: the HTTP parser of Go refuses a target with an invalid
	// escape before the handler is reached; the answer is then its plain 400.
	// Either way nothing reaches the daemon.
	plain400 bool
}

// runDeny sends every case on a connection of its own and checks the answer.
func (r *rig) runDeny(t *testing.T, cases []denyCase) {
	t.Helper()
	for _, c := range cases {
		c := c
		t.Run(c.method+" "+c.target, func(t *testing.T) {
			res := r.send(c.method, c.target, c.hdr, c.body)
			if c.plain400 && denyCode(res) == "" {
				if res.Status != 400 {
					t.Errorf("status %d, want a denial or the 400 of the HTTP parser; body %q", res.Status, res.str())
				}
				return
			}
			wantDeny(t, res, c.code)
			if mustClose[c.code] && !res.Close {
				t.Errorf("the connection is kept after %s", c.code)
			}
		})
	}
}

// --- the closed list ------------------------------------------------------------------

type callSpec struct{ method, path string }

// closedList is the "closed" list of the specification (6.1): everything the
// Docker API has that the allowlist does not name. Paths are without the
// version prefix.
func closedList(r *rig) []callSpec {
	var out []callSpec
	add := func(method string, paths ...string) {
		for _, p := range paths {
			out = append(out, callSpec{method, p})
		}
	}
	seg := imageSeg(r.m.Image)

	// The verbs of a container that are not allowed, for every way of naming one:
	// the main, .next, the helper, the 64-hex Id, the short Id, a plain name.
	names := []string{r.name(""), r.name(".next"), r.name(".helper"), boardID, boardID[:12], "board"}
	for _, n := range names {
		for _, verb := range []string{"exec", "attach", "commit", "kill", "pause", "unpause", "update", "resize"} {
			add("POST", "/containers/"+n+"/"+verb)
		}
		for _, verb := range []string{"attach/ws", "export", "changes", "top", "stats"} {
			add("GET", "/containers/"+n+"/"+verb)
		}
	}

	add("GET", "/containers/json", "/containers/json?all=true", "/containers/json?all=1&filters=%7B%7D")
	add("POST", "/containers/prune", "/containers/prune?filters=%7B%7D", "/containers/create", "/containers/create?",
		"/containers/create?name=x")

	add("POST", "/exec/abc123/start", "/exec/abc123/resize")
	add("GET", "/exec/abc123/json")

	add("POST", "/images/create?fromImage=alpine", "/images/create?fromImage=alpine&tag=latest",
		"/images/"+seg+"/push", "/images/"+seg+"/tag?repo=x", "/images/prune", "/images/load")
	add("GET", "/images/"+seg+"/history", "/images/"+seg+"/get", "/images/json", "/images/json?all=1",
		"/images/search?term=alpine", "/images/get?names=alpine")
	add("DELETE", "/images/"+seg, "/images/"+seg+"?force=true", "/images/alpine", "/images/"+imageSeg(r.m.ImageID))

	add("POST", "/build", "/build?t=x", "/build/prune", "/commit?container=x")

	add("GET", "/volumes", "/volumes/x")
	add("POST", "/volumes/create", "/volumes/prune")
	add("DELETE", "/volumes/x")

	add("GET", "/networks", "/networks/x")
	add("POST", "/networks/create", "/networks/x/connect", "/networks/x/disconnect", "/networks/prune")
	add("DELETE", "/networks/x")

	add("GET", "/plugins", "/plugins/x/json")
	add("POST", "/plugins/pull", "/plugins/x/enable")
	add("DELETE", "/plugins/x")

	add("GET", "/swarm", "/swarm/unlockkey")
	add("POST", "/swarm/init", "/swarm/join", "/swarm/leave", "/swarm/unlock")

	add("GET", "/services", "/services/x", "/nodes", "/nodes/x", "/tasks", "/tasks/x", "/secrets", "/secrets/x", "/configs", "/configs/x")
	add("POST", "/services/create", "/secrets/create", "/configs/create")

	add("GET", "/system/df", "/info", "/version", "/_ping", "/events", "/events?since=0", "/distribution/alpine/json", "/session")
	add("POST", "/session", "/auth")
	return out
}

func TestDeny_ClosedList(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	var cases []denyCase
	for _, c := range closedList(r) {
		// With the version prefix the route is not on the list; without it the
		// version is the first thing that is wrong.
		cases = append(cases,
			denyCase{method: c.method, target: pfx + c.path, code: deny.RouteNotAllowed},
			denyCase{method: c.method, target: c.path, code: deny.APIVersion},
		)
	}
	r.runDeny(t, cases)
	r.wantNoCalls()
}

func TestDeny_ApiVersion(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	tail := "/containers/" + r.name("") + "/json"
	var cases []denyCase
	for _, target := range []string{
		tail,
		"/v1.44" + tail,
		"/v1.56" + tail,
		"/v1.4" + tail,
		"/v1.450" + tail,
		"/v1.45.0" + tail,
		"/v2" + tail,
		"/V1.45" + tail,
		"/v1.45" + tail[1:],
		"//v1.45" + tail,
		"/api/v1.45" + tail,
		"/v1.45",
		"/",
		"/_ping",
		"/version",
		"/images/" + imageSeg(r.m.Image) + "/json",
	} {
		cases = append(cases, denyCase{method: "GET", target: target, code: deny.APIVersion})
	}
	r.runDeny(t, cases)
	r.wantNoCalls()
}

// TestRedTeam_RT1_8_MethodsOutsideTheAllowlist: a method that is not one of
// GET, POST, PUT and DELETE is refused on every target, HEAD included: it is
// never turned into a GET that would be allowed.
func TestRedTeam_RT1_8_MethodsOutsideTheAllowlist(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	targets := []string{
		r.imageTarget(),
		r.target("", "/json"),
		r.target("", "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json"),
		"/v1.45/containers/create?name=" + r.name(""),
		r.target("", "/start"),
		r.target(".helper", "/wait?condition=not-running"),
		r.target(".helper", "/logs?stdout=true&stderr=true&tail=20"),
		r.target(".helper", "/archive?path=%2Fworkspace&noOverwriteDirNonDir=true"),
		r.target("", "?force=true&v=true"),
		r.target("", "/stop?t=30"),
		r.target("", "/restart?t=30"),
		r.target(".next", "/rename?name="+r.name("")),
		"/v1.45/containers/json",
		"/v1.45/_ping",
	}
	n := 0
	for _, method := range []string{"HEAD", "OPTIONS", "PATCH", "TRACE", "get", "PROPFIND"} {
		for _, target := range targets {
			method, target := method, target
			n++
			t.Run(method+" "+target, func(t *testing.T) {
				res := r.send(method, target, nil, nil)
				if method == "HEAD" {
					// No body in the answer to HEAD, but the head of the denial.
					if res.Status != 403 {
						t.Errorf("status %d, want 403", res.Status)
					}
					want := strconv.Itoa(len(deny.Message(deny.MethodNotAllowed)))
					if got := res.Header.Get("Content-Length"); got != "" && got != want {
						t.Errorf("Content-Length %q, want %q", got, want)
					}
					return
				}
				wantDeny(t, res, deny.MethodNotAllowed)
			})
		}
	}
	ds := r.decisions()
	if len(ds) != n {
		t.Fatalf("%d decisions for %d requests", len(ds), n)
	}
	for _, d := range ds {
		if d.Decision != "deny" || d.Reason != deny.MethodNotAllowed {
			t.Errorf("decision %+v", d)
		}
	}
	r.wantNoCalls()
}

func TestDeny_MethodsOfTheRouteAreExact(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	var cases []denyCase
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		cases = append(cases,
			denyCase{method: method, target: r.target("", "/json"), code: deny.RouteNotAllowed},
			denyCase{method: method, target: r.imageTarget(), code: deny.RouteNotAllowed},
			denyCase{method: method, target: r.target("", "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json"), code: deny.RouteNotAllowed},
		)
	}
	r.runDeny(t, cases)
	r.wantNoCalls()
}

// --- routes that look like the allowed ones -----------------------------------------------

// TestRedTeam_RT1_8_RouteBypass: the request-target is matched as it stands,
// without a decoding, a cleaning or a normalization. Whatever is one character
// away from a template is not the template.
func TestRedTeam_RT1_8_RouteBypass(t *testing.T) {
	r := newRig(t)
	r.seedMain("exited")
	r.seedNext("created")
	r.seedApplyHelper("0123456789abcdef", "created")

	M, N, H, K := r.name(""), r.name(".next"), r.name(".helper"), r.key()
	P := pfx + "/containers/"
	marker := "path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json"
	flag := "&noOverwriteDirNonDir=true"
	otherM := "myrmidon-bot-" + otherKey

	var cases []denyCase
	add := func(method string, targets ...string) {
		for _, tg := range targets {
			cases = append(cases, denyCase{method: method, target: tg, code: deny.RouteNotAllowed})
		}
	}
	addEsc := func(method string, targets ...string) {
		for _, tg := range targets {
			cases = append(cases, denyCase{method: method, target: tg, code: deny.RouteNotAllowed, plain400: true})
		}
	}

	// A1: the image
	seg := imageSeg(r.m.Image)
	tagged := imageSeg(r.m.Image[:strings.Index(r.m.Image, "@")] + ":latest")
	add("GET",
		pfx+"/images/busybox/json",
		pfx+"/images/"+tagged+"/json",
		pfx+"/images/"+strings.ReplaceAll(seg, "/", "%2F")+"/json",
		pfx+"/images/"+strings.ReplaceAll(seg, "%3A", "%3a")+"/json",
		pfx+"/images/"+strings.NewReplacer("%40", "@", "%3A", ":").Replace(seg)+"/json",
		pfx+"/images/"+imageSeg(r.m.ImageID)+"/json",
		pfx+"/images/"+seg+"/json?",
		pfx+"/images/"+seg+"/json?x=1",
		pfx+"/images/"+seg+"/json/",
		pfx+"/images/"+seg+"/json;x",
		pfx+"/images/"+seg+"//json",
		pfx+"/images/"+seg+"/JSON",
		pfx+"/images/"+seg,
		pfx+"/images//"+seg+"/json",
	)
	add("POST", r.imageTarget())
	add("PUT", r.imageTarget())
	add("DELETE", r.imageTarget())

	// A2
	add("GET",
		P+M+"/json/",
		P+M+"/json?",
		P+M+"/json?x=1",
		P+M+"/json?all=true",
		P+M+"/JSON",
		P+M+"//json",
		P+M+"/./json",
		P+M+"/../"+M+"/json",
		P+M+"/json;a=b",
		P+M+"/json#x",
		P+M+"%00/json",
		P+M+"%2Fjson",
		P+M+"%2e%2e/json",
		P+"%2e%2e/"+M+"/json",
		P+M+"/%2e%2e/json",
		P+M+"/%6ason",
		P+M+"/json%C3%A9",
		pfx+"/containers/%6dyrmidon-bot-"+K+"/json",
		P+"myrmidon-bot-"+strings.ToUpper(K)+"/json",
		P+"MYRMIDON-BOT-"+K+"/json",
		P+"myrmidon-bot-123/json",
		P+"myrmidon-bot-"+K+"0/json",
		P+"myrmidon-bot-"+K[1:]+"/json",
		P+"myrmidon-bot-{"+K+"}/json",
		P+"myrmidon-bot-"+strings.ReplaceAll(K, "-", "")+"/json",
		P+"myrmidon-bot-/json",
		P+"myrmidon-bot/json",
		P+M+".Next/json",
		P+M+".NEXT/json",
		P+M+".helper.next/json",
		P+M+".next.helper/json",
		P+M+".nextx/json",
		P+M+".helper/json",
		P+H+"/json",
		P+N+"/json",
		P+boardID+"/json",
		P+boardID[:12]+"/json",
		P+"board/json",
		P+M+"?force=true&v=true",
	)
	addEsc("GET",
		P+M+"/json%",
		P+M+"/json%2",
		P+M+"/json%zz",
		P+M+"/js%g1on",
	)

	// A3
	a3 := P + M + "/archive?"
	add("GET",
		a3+marker+"&x=1",
		a3+marker+"&",
		a3+"x=1&"+marker,
		a3+marker+"&"+marker,
		a3+"path=%2Fetc%2Fpasswd",
		a3+"path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.jsom",
		a3+"path=/data/hermes/.myrmidon/applied.json",
		a3+"path=%2fdata%2fhermes%2f.myrmidon%2fapplied.json",
		a3+"path=%2Fdata%2Fhermes%2F%2Emyrmidon%2Fapplied.json",
		a3+"path=%2Fdata%2Fhermes%2F.myrmidon%2F..%2F..%2Fetc%2Fpasswd",
		a3+"path=%2Fdata%2Fhermes",
		a3+"path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json%2F",
		a3+"path=",
		a3+"Path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json",
		P+M+"/archive",
		P+M+"/archive?",
		P+M+"/archive/?"+marker,
		P+H+"/archive?"+marker,
		P+N+"/archive?"+marker,
	)
	add("POST", a3+marker)
	add("PUT", a3+marker)
	add("DELETE", a3+marker)
	add("PUT", a3+"path=%2Fworkspace"+flag)

	// A4
	c4 := pfx + "/containers/create"
	add("POST",
		c4,
		c4+"?",
		c4+"?name=",
		c4+"?name=myrmidon-bot-",
		c4+"?name=other",
		c4+"?name=busybox",
		c4+"?name="+M+"&x=1",
		c4+"?x=1&name="+M,
		c4+"?name="+M+"&name="+M,
		c4+"?name="+M+"%00",
		c4+"?Name="+M,
		c4+"?name="+strings.ToUpper(M),
		c4+"?name=myrmidon-bot-"+strings.ToUpper(K),
		c4+"?name="+M+".foo",
		c4+"?name="+M+".next.next",
		c4+"?name="+M+".helper.next",
		c4+"?name="+M+"/",
		c4+"?name="+M+";",
		c4+"?name="+M+"%2Fjson",
		c4+"?name=myrmidon-bot-"+K[:35],
		c4+"/?name="+M,
		pfx+"/containers/Create?name="+M,
	)
	addEsc("POST", c4+"?name="+M+"%")
	add("GET", c4+"?name="+M)
	add("PUT", c4+"?name="+M)
	add("DELETE", c4+"?name="+M)

	// A5
	a5 := P + H + "/archive?"
	add("PUT",
		a5+"path=%2Fdata%2Fhermes",
		a5+"path=%2Fdata%2Fhermes&noOverwriteDirNonDir=false",
		a5+"path=%2Fdata%2Fhermes&noOverwriteDirNonDir=1",
		a5+"path=%2Fdata%2Fhermes"+flag+"&copyUIDGID=true",
		a5+"path=%2Fdata%2Fhermes"+flag+"&",
		a5+"noOverwriteDirNonDir=true&path=%2Fdata%2Fhermes",
		a5+"path=%2Fdata%2Fhermes%2F.."+flag,
		a5+"path=%2Fdata"+flag,
		a5+"path=%2Fdata%2Fhermes%2F"+flag,
		a5+"path=%2Fdata%2Fhermes%2Fskills-board"+flag,
		a5+"path=%2Fworkspace%2F.myrmidon"+flag,
		a5+"path=%2F"+flag,
		a5+"path="+flag,
		a5+"path=%2Fetc"+flag,
		a5+"path=%2Fscratch%2F..%2Fdata"+flag,
		a5+"path=/workspace"+flag,
		a5+"path=%2fworkspace"+flag,
		a5+"path=%2Fworkspace"+flag+"&path=%2Fscratch",
		a5+"path=%2Fworkspace&path=%2Fscratch"+flag,
		a5+"path=%2FWorkspace"+flag,
		a5+"path=%2Fworkspace&noOverwriteDirNonDir=True",
		P+H+"/archive",
		P+H+"/archive?",
		P+M+"/archive?path=%2Fworkspace"+flag,
		P+N+"/archive?path=%2Fworkspace"+flag,
		P+"myrmidon-bot-"+strings.ToUpper(K)+".helper/archive?path=%2Fworkspace"+flag,
	)
	add("POST", a5+"path=%2Fworkspace"+flag)
	add("GET", a5+"path=%2Fworkspace"+flag)
	add("DELETE", a5+"path=%2Fworkspace"+flag)

	// A6
	add("POST",
		P+N+"/start",
		P+M+"/start?x=1",
		P+M+"/start?",
		P+M+"/start/",
		P+M+"/Start",
		P+M+"/start/x",
		P+M+"/start?t=1",
	)
	add("GET", P+M+"/start", P+H+"/start")
	add("PUT", P+M+"/start")
	add("DELETE", P+M+"/start")

	// A7
	wait := "/wait?condition=not-running"
	add("POST",
		P+M+wait,
		P+N+wait,
		P+H+"/wait",
		P+H+"/wait?",
		P+H+"/wait?condition=next-exit",
		P+H+"/wait?condition=removed",
		P+H+wait+"&x=1",
		P+H+"/wait?condition=Not-Running",
		P+H+wait+"&condition=removed",
	)
	add("GET", P+H+wait)
	add("PUT", P+H+wait)
	add("DELETE", P+H+wait)

	// A8
	logs := "/logs?stdout=true&stderr=true&tail=20"
	add("GET",
		P+M+logs,
		P+N+logs,
		P+H+logs+"&follow=true",
		P+H+logs+"&timestamps=true",
		P+H+logs+"&since=0",
		P+H+"/logs?stdout=true&stderr=true&tail=all",
		P+H+"/logs?stdout=true&stderr=true&tail=200",
		P+H+"/logs?stderr=true&stdout=true&tail=20",
		P+H+"/logs?stdout=true&tail=20",
		P+H+"/logs?stdout=true&stderr=true",
		P+H+"/logs",
		P+H+"/logs?",
	)
	add("POST", P+H+logs)
	add("PUT", P+H+logs)
	add("DELETE", P+H+logs)

	// A9
	for _, n := range []string{M, N, H} {
		add("DELETE",
			P+n+"?force=true",
			P+n+"?v=true",
			P+n+"?v=true&force=true",
			P+n+"?force=true&v=true&link=true",
			P+n+"?force=true&v=true&",
			P+n+"?force=1&v=1",
			P+n+"?force=true&v=false",
			P+n+"?force=false&v=true",
			P+n+"?Force=true&v=true",
			P+n+"?force=true&force=true&v=true",
			P+n,
			P+n+"?",
			P+n+"/?force=true&v=true",
		)
		add("POST", P+n+"?force=true&v=true")
		add("GET", P+n+"?force=true&v=true")
		add("PUT", P+n+"?force=true&v=true")
	}

	// A10 and A11
	for _, verb := range []string{"stop", "restart"} {
		add("POST",
			P+M+"/"+verb+"?t=0",
			P+M+"/"+verb+"?t=3",
			P+M+"/"+verb,
			P+M+"/"+verb+"?",
			P+M+"/"+verb+"?t=30&signal=KILL",
			P+M+"/"+verb+"?signal=KILL",
			P+M+"/"+verb+"?t=30&",
			P+M+"/"+verb+"?t=030",
			P+M+"/"+verb+"?t=-1",
			P+M+"/"+verb+"?T=30",
			P+M+"/"+verb+"?t=30&t=30",
			P+M+"/"+verb+"/?t=30",
			P+H+"/"+verb+"?t=30",
			P+N+"/"+verb+"?t=30",
		)
		add("GET", P+M+"/"+verb+"?t=30")
		add("PUT", P+M+"/"+verb+"?t=30")
		add("DELETE", P+M+"/"+verb+"?t=30")
	}

	// A12
	ren := P + N + "/rename?name="
	add("POST",
		ren+otherM,
		ren+N,
		ren+H,
		ren+"foo",
		ren,
		ren+M+"&x=1",
		ren+M+"&name="+M,
		ren+M+"/x",
		ren+M+"%00",
		ren+strings.ToUpper(M),
		ren+"myrmidon-bot-"+strings.ToUpper(K),
		P+N+"/rename",
		P+N+"/rename?",
		P+N+"/rename?Name="+M,
		P+M+"/rename?name="+M,
		P+M+"/rename?name="+N,
		P+H+"/rename?name="+M,
		P+"myrmidon-bot-"+otherKey+".next/rename?name="+M,
	)
	add("GET", ren+M)
	add("PUT", ren+M)
	add("DELETE", ren+M)

	// Ids and short names in the routes that take a name.
	for _, id := range []string{boardID, boardID[:12], "board"} {
		add("GET", P+id+"/json")
		add("POST", P+id+"/start", P+id+"/stop?t=30", P+id+"/restart?t=30")
		add("DELETE", P+id+"?force=true&v=true")
	}

	r.runDeny(t, cases)
	r.wantNoCalls()
}

// --- the form of the target and the HTTP version ---------------------------------------

func TestDeny_TargetForms(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	json := "/containers/" + r.name("") + "/json"
	r.runDeny(t, []denyCase{
		{method: "GET", target: "http://docker" + pfx + json, code: deny.TargetForm},
		{method: "GET", target: "https://docker" + pfx + json, code: deny.TargetForm},
		{method: "GET", target: "http://docker", code: deny.TargetForm},
		{method: "POST", target: "http://docker" + pfx + "/containers/" + r.name("") + "/start", code: deny.TargetForm},
		{method: "OPTIONS", target: "*", code: deny.TargetForm},
		{method: "GET", target: "*", code: deny.TargetForm},
		{method: "CONNECT", target: "docker:80", code: deny.TargetForm},
		{method: "GET", target: strings.TrimPrefix(pfx+json, "/"), code: deny.TargetForm, plain400: true},
	})
	r.wantNoCalls()
}

func TestDeny_HTTPVersion(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	res := r.raw([]byte("GET "+pfx+"/containers/"+r.name("")+"/json HTTP/1.0\r\n\r\n"), "GET")
	wantDeny(t, res, deny.TargetForm)
	if d := r.lastDecision(); d.Detail != "http_version" {
		t.Errorf("detail %q, want http_version", d.Detail)
	}

	// The preface of HTTP/2 is not HTTP/1.1 either: Go hands it to the handler,
	// or refuses it itself.
	res = r.raw([]byte("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"), "PRI")
	if denyCode(res) == "" {
		if res.Status != 400 && res.Status != 505 {
			t.Errorf("status %d, body %q", res.Status, res.str())
		}
	} else {
		wantDeny(t, res, deny.TargetForm)
	}
	r.wantNoCalls()
}

// --- headers ---------------------------------------------------------------------------------

func chunked(body []byte) []byte {
	return []byte(fmt.Sprintf("%x\r\n%s\r\n0\r\n\r\n", len(body), body))
}

func TestDeny_Headers(t *testing.T) {
	type hc struct {
		name   string
		method string
		target func(r *rig) string
		hdr    map[string]string
		body   func(r *rig, t *testing.T) []byte
		status int
		detail string
	}
	get := func(r *rig) string { return r.target("", "/json") }
	create := func(r *rig) string { return "/v1.45/containers/create?name=" + r.name("") }
	botBody := func(r *rig, t *testing.T) []byte {
		_, b := r.m.FindBody(t, "bot-plain", "")
		return b
	}
	chunkedBot := func(r *rig, t *testing.T) []byte { return chunked(botBody(r, t)) }
	cases := []hc{
		{"chunked on a GET", "GET", get, map[string]string{"Transfer-Encoding": "chunked"},
			func(*rig, *testing.T) []byte { return []byte("0\r\n\r\n") }, 400, "transfer-encoding"},
		{"chunked on the create", "POST", create, map[string]string{"Transfer-Encoding": "chunked", "Content-Type": "application/json"},
			chunkedBot, 400, "transfer-encoding"},
		{"Upgrade", "GET", get, map[string]string{"Upgrade": "websocket"}, nil, 403, "upgrade"},
		{"Upgrade h2c", "GET", get, map[string]string{"Upgrade": "h2c", "Connection": "Upgrade, HTTP2-Settings"}, nil, 403, "upgrade"},
		{"Connection Upgrade", "GET", get, map[string]string{"Connection": "Upgrade"}, nil, 403, "connection-upgrade"},
		{"Connection keep-alive, Upgrade", "GET", get, map[string]string{"Connection": "keep-alive, Upgrade"}, nil, 403, "connection-upgrade"},
		{"Connection upgrade in lower case", "GET", get, map[string]string{"Connection": "upgrade"}, nil, 403, "connection-upgrade"},
		{"Expect on the create", "POST", create, map[string]string{"Expect": "100-continue", "Content-Type": "application/json"},
			botBody, 403, "expect"},
		{"Expect on a GET", "GET", get, map[string]string{"Expect": "100-continue"}, nil, 403, "expect"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t)
			r.seedMain("running")
			var body []byte
			if c.body != nil {
				body = c.body(r, t)
			}
			res := r.send(c.method, c.target(r), c.hdr, body)
			wantDenyStatus(t, res, c.status, deny.HeaderForbidden)
			if !res.Close {
				t.Error("the connection is kept")
			}
			if d := r.lastDecision(); d.Detail != c.detail {
				t.Errorf("detail %q, want %q", d.Detail, c.detail)
			}
			r.wantNoCalls()
		})
	}

	// Content-Length beside Transfer-Encoding: what Go does with the pair is its
	// business (it may refuse it itself); the gate never treats it as a request
	// with a length.
	t.Run("Content-Length with Transfer-Encoding", func(t *testing.T) {
		r := newRig(t)
		r.seedMain("running")
		res := r.send("POST", create(r), map[string]string{
			"Transfer-Encoding": "chunked", "Content-Length": "5", "Content-Type": "application/json",
		}, []byte("5\r\nhello\r\n0\r\n\r\n"))
		if denyCode(res) == "" {
			if res.Status != 400 {
				t.Errorf("status %d, body %q", res.Status, res.str())
			}
		} else {
			wantDenyStatus(t, res, 400, deny.HeaderForbidden)
		}
		r.wantNoCalls()
	})

	// Framings that Go refuses itself, or hands over: none reaches the daemon.
	t.Run("other Transfer-Encoding", func(t *testing.T) {
		for _, te := range []string{"identity", "gzip, chunked", "gzip", "chunked, chunked"} {
			r := newRig(t)
			r.seedMain("running")
			res := r.send("GET", get(r), map[string]string{"Transfer-Encoding": te}, []byte("0\r\n\r\n"))
			switch res.Status {
			case 400, 501:
			default:
				t.Errorf("Transfer-Encoding %q: status %d, body %q", te, res.Status, res.str())
			}
			r.wantNoCalls()
		}
	})
	t.Run("Expect other than 100-continue", func(t *testing.T) {
		r := newRig(t)
		r.seedMain("running")
		res := r.send("GET", get(r), map[string]string{"Expect": "something-else"}, nil)
		switch res.Status {
		case 403:
			wantDeny(t, res, deny.HeaderForbidden)
		case 417:
		default:
			t.Errorf("status %d, body %q", res.Status, res.str())
		}
		r.wantNoCalls()
	})
}

// --- Content-Type and the body ----------------------------------------------------------------

func TestDeny_ContentType(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	r.seedApplyHelper("0123456789abcdef", "created")
	_, body := r.m.FindBody(t, "bot-plain", "")
	create := "/v1.45/containers/create?name=" + r.name("")
	put := r.target(".helper", "/archive?path=%2Fdata%2Fhermes&noOverwriteDirNonDir=true")
	a := r.m.Archives[0]
	tarBytes := fixture.ArchiveBytes(t, a)

	var cases []denyCase
	for _, ct := range []struct {
		name string
		hdr  map[string]string
	}{
		{"absent", nil},
		{"empty", map[string]string{"Content-Type": ""}},
		{"charset", map[string]string{"Content-Type": "application/json; charset=utf-8"}},
		{"case", map[string]string{"Content-Type": "Application/JSON"}},
		{"text", map[string]string{"Content-Type": "text/plain"}},
		{"two in one", map[string]string{"Content-Type": "application/json,application/json"}},
		{"tar for json", map[string]string{"Content-Type": "application/x-tar"}},
		{"octet-stream", map[string]string{"Content-Type": "application/octet-stream"}},
		{"form", map[string]string{"Content-Type": "application/x-www-form-urlencoded"}},
	} {
		cases = append(cases, denyCase{method: "POST", target: create, hdr: ct.hdr, body: body, code: deny.ContentType})
	}
	for _, ct := range []map[string]string{
		nil,
		{"Content-Type": ""},
		{"Content-Type": "application/json"},
		{"Content-Type": "application/x-tar; charset=binary"},
		{"Content-Type": "Application/X-Tar"},
		{"Content-Type": "application/octet-stream"},
		{"Content-Type": "application/gzip"},
	} {
		cases = append(cases, denyCase{method: "PUT", target: put, hdr: ct, body: tarBytes, code: deny.ContentType})
	}
	r.runDeny(t, cases)

	// Two Content-Type headers, each right: still not one.
	dup := []byte("POST " + create + " HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Type: application/json\r\n" +
		"Content-Length: " + strconv.Itoa(len(body)) + "\r\n\r\n" + string(body))
	wantDeny(t, r.raw(dup, "POST"), deny.ContentType)
	dup = []byte("PUT " + put + " HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-tar\r\nContent-Type: application/x-tar\r\n" +
		"Content-Length: " + strconv.Itoa(len(tarBytes)) + "\r\n\r\n" + string(tarBytes))
	wantDeny(t, r.raw(dup, "PUT"), deny.ContentType)
	r.wantNoCalls()
}

func TestDeny_BodyWhereThereIsNone(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	r.seedNext("created")
	r.seedApplyHelper("0123456789abcdef", "created")
	M, N, H := r.name(""), r.name(".next"), r.name(".helper")
	P := pfx + "/containers/"
	json := []byte(`{}`)
	r.runDeny(t, []denyCase{
		{method: "GET", target: r.imageTarget(), hdr: jsonHdr, body: json, code: deny.BodyNotAllowed},
		{method: "GET", target: P + M + "/json", hdr: jsonHdr, body: json, code: deny.BodyNotAllowed},
		{method: "GET", target: P + M + "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json", body: []byte("x"), code: deny.BodyNotAllowed},
		{method: "GET", target: P + H + "/logs?stdout=true&stderr=true&tail=20", body: []byte("x"), code: deny.BodyNotAllowed},
		{method: "POST", target: P + M + "/start", hdr: jsonHdr, body: json, code: deny.BodyNotAllowed},
		{method: "POST", target: P + H + "/start", body: []byte("x"), code: deny.BodyNotAllowed},
		{method: "POST", target: P + H + "/wait?condition=not-running", body: []byte("x"), code: deny.BodyNotAllowed},
		{method: "POST", target: P + M + "/stop?t=30", body: []byte("x"), code: deny.BodyNotAllowed},
		{method: "POST", target: P + M + "/restart?t=30", body: []byte("x"), code: deny.BodyNotAllowed},
		{method: "POST", target: P + N + "/rename?name=" + M, body: []byte("x"), code: deny.BodyNotAllowed},
		{method: "DELETE", target: P + H + "?force=true&v=true", hdr: jsonHdr, body: json, code: deny.BodyNotAllowed},
		{method: "DELETE", target: P + N + "?force=true&v=true", body: []byte("x"), code: deny.BodyNotAllowed},
		{method: "DELETE", target: P + M + "?force=true&v=true", body: []byte("x"), code: deny.BodyNotAllowed},
	})
	r.wantNoCalls()
}

func TestDeny_BodyLimits(t *testing.T) {
	r := newRig(t)
	r.seedApplyHelper("0123456789abcdef", "created")
	create := "/v1.45/containers/create?name=" + r.name("")
	put := r.target(".helper", "/archive?path=%2Fdata%2Fhermes&noOverwriteDirNonDir=true")

	// The declared length is enough: the body is not read.
	for _, c := range []struct {
		name, method, target string
		hdr                  map[string]string
		length               int
	}{
		{"json, one over", "POST", create, jsonHdr, 64<<10 + 1},
		{"json, far over", "POST", create, jsonHdr, 1 << 30},
		{"tar, one over", "PUT", put, tarHdr, 16<<20 + 1},
		{"tar, far over", "PUT", put, tarHdr, 1 << 30},
	} {
		c := c
		t.Run(c.name, func(t *testing.T) {
			hdr := map[string]string{"Content-Length": strconv.Itoa(c.length)}
			for k, v := range c.hdr {
				hdr[k] = v
			}
			code := deny.BodyTooLarge
			res := r.send(c.method, c.target, hdr, []byte("{"))
			wantDeny(t, res, code)
			if !res.Close {
				t.Error("the connection is kept")
			}
		})
	}

	// A body that really is over the limit.
	t.Run("json body over the limit", func(t *testing.T) {
		res := r.send("POST", create, jsonHdr, bytes.Repeat([]byte(" "), 64<<10+1))
		wantDeny(t, res, deny.BodyTooLarge)
	})
	r.wantNoCalls()
}

// --- what the gate does not do -------------------------------------------------------------

// TestRedTeam_RT1_8_SmugglingInABody: a request that hides in the body of
// another is never a second request. The gate does not pass bytes through, and
// the connection after such a request is closed.
func TestRedTeam_RT1_8_SmugglingInABody(t *testing.T) {
	inner := func(r *rig) string {
		return "GET " + pfx + "/containers/" + r.name("") + "/json HTTP/1.1\r\nHost: x\r\n\r\n"
	}

	t.Run("in the body of a start", func(t *testing.T) {
		r := newRig(t)
		r.seedMain("running")
		c := r.dial()
		defer c.close()
		res := c.do("POST", r.target("", "/start"), nil, []byte(inner(r)))
		wantDeny(t, res, deny.BodyNotAllowed)
		if !res.Close {
			t.Error("the connection is kept")
		}
		c.wantClosed()
		r.wantNoCalls()
	})

	t.Run("in the body of a delete", func(t *testing.T) {
		r := newRig(t)
		r.seedMain("exited")
		c := r.dial()
		defer c.close()
		res := c.do("DELETE", r.target("", "?force=true&v=true"), nil, []byte(inner(r)))
		wantDeny(t, res, deny.BodyNotAllowed)
		c.wantClosed()
		r.wantNoCalls()
	})

	t.Run("behind the JSON of a create", func(t *testing.T) {
		r := newRig(t)
		_, body := r.m.FindBody(t, "bot-plain", "")
		tail := append(append([]byte{}, body...), []byte("\r\n"+inner(r))...)
		res := r.send("POST", "/v1.45/containers/create?name="+r.name(""), jsonHdr, tail)
		wantDenyOneOf(t, res, deny.JSONSyntax, deny.JSONNotCanonical)
		r.wantNoCalls()
	})

	t.Run("behind the tar of an upload", func(t *testing.T) {
		r := newRig(t)
		r.seedApplyHelper("0123456789abcdef", "created")
		a := r.m.Archives[0]
		tail := append(append([]byte{}, fixture.ArchiveBytes(t, a)...), []byte(inner(r))...)
		res := r.send("PUT", r.target(".helper", "/archive?path="+escPath(a.MountPath)+"&noOverwriteDirNonDir=true"), tarHdr, tail)
		wantDeny(t, res, deny.TarSyntax)
		if r.count("PUT", "/v1.45/containers/") != 0 {
			t.Errorf("a tar with a tail reached the daemon: %v", r.uris())
		}
	})
}

// TestRedTeam_RT1_8_Pipelining: two requests in one write are two requests. The
// daemon gets what the gate builds for the ones that pass, and nothing for the
// ones that do not.
func TestRedTeam_RT1_8_Pipelining(t *testing.T) {
	t.Run("allowed, then forbidden", func(t *testing.T) {
		r := newRig(t)
		r.seedMain("running")
		first := buildRaw("GET", r.target("", "/json"), nil, nil)
		second := buildRaw("GET", pfx+"/containers/json", nil, nil)
		c := r.dial()
		defer c.close()
		c.write(append(first, second...))
		a := c.read("GET")
		b := c.read("GET")
		wantStatus(t, a, 200)
		wantDeny(t, b, deny.RouteNotAllowed)
		r.wantURIs("GET " + r.target("", "/json"))
	})

	t.Run("forbidden, then allowed", func(t *testing.T) {
		r := newRig(t)
		r.seedMain("running")
		first := buildRaw("GET", pfx+"/containers/json", nil, nil)
		second := buildRaw("GET", r.target("", "/json"), nil, nil)
		c := r.dial()
		defer c.close()
		c.write(append(first, second...))
		a := c.read("GET")
		b := c.read("GET")
		wantDeny(t, a, deny.RouteNotAllowed)
		wantStatus(t, b, 200)
		r.wantURIs("GET " + r.target("", "/json"))
	})

	t.Run("create, then forbidden", func(t *testing.T) {
		r := newRig(t)
		_, body := r.m.FindBody(t, "bot-plain", "")
		name := r.name("")
		first := buildRaw("POST", "/v1.45/containers/create?name="+name, jsonHdr, body)
		second := buildRaw("POST", pfx+"/containers/"+name+"/exec", nil, nil)
		c := r.dial()
		defer c.close()
		c.write(append(first, second...))
		a := c.read("POST")
		b := c.read("POST")
		wantStatus(t, a, 201)
		wantDeny(t, b, deny.RouteNotAllowed)
		if r.created() != 1 || len(r.calls()) != 2 {
			t.Errorf("calls to the daemon: %v", r.uris())
		}
		got, ok := r.d.Get(name)
		if !ok || !bytes.Equal(got.Create, body) {
			t.Error("the daemon did not get the canonical body")
		}
	})

	t.Run("two forbidden", func(t *testing.T) {
		r := newRig(t)
		first := buildRaw("GET", pfx+"/containers/json", nil, nil)
		second := buildRaw("GET", pfx+"/info", nil, nil)
		third := buildRaw("HEAD", pfx+"/containers/json", nil, nil)
		c := r.dial()
		defer c.close()
		c.write(bytes.Join([][]byte{first, second, third}, nil))
		wantDeny(t, c.read("GET"), deny.RouteNotAllowed)
		wantDeny(t, c.read("GET"), deny.RouteNotAllowed)
		if res := c.read("HEAD"); res.Status != 403 {
			t.Errorf("status %d", res.Status)
		}
		r.wantNoCalls()
	})
}

// --- the bot of the request ----------------------------------------------------------------------

func TestDeny_BotNotEnrolled(t *testing.T) {
	r := newRig(t)
	other := func(sfx string) string { return "myrmidon-bot-" + otherKey + sfx }
	P := pfx + "/containers/"
	flag := "&noOverwriteDirNonDir=true"
	_, body := r.m.FindBody(t, "bot-plain", "")
	r.runDeny(t, []denyCase{
		{method: "GET", target: P + other("") + "/json", code: deny.BotNotEnrolled},
		{method: "GET", target: P + other("") + "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json", code: deny.BotNotEnrolled},
		{method: "POST", target: pfx + "/containers/create?name=" + other(""), hdr: jsonHdr, body: body, code: deny.BotNotEnrolled},
		{method: "POST", target: pfx + "/containers/create?name=" + other(".next"), hdr: jsonHdr, body: body, code: deny.BotNotEnrolled},
		{method: "POST", target: pfx + "/containers/create?name=" + other(".helper"), hdr: jsonHdr, body: body, code: deny.BotNotEnrolled},
		{method: "PUT", target: P + other(".helper") + "/archive?path=%2Fworkspace" + flag, hdr: tarHdr, code: deny.BotNotEnrolled},
		{method: "POST", target: P + other("") + "/start", code: deny.BotNotEnrolled},
		{method: "POST", target: P + other(".helper") + "/start", code: deny.BotNotEnrolled},
		{method: "POST", target: P + other(".helper") + "/wait?condition=not-running", code: deny.BotNotEnrolled},
		{method: "GET", target: P + other(".helper") + "/logs?stdout=true&stderr=true&tail=20", code: deny.BotNotEnrolled},
		{method: "DELETE", target: P + other("") + "?force=true&v=true", code: deny.BotNotEnrolled},
		{method: "DELETE", target: P + other(".next") + "?force=true&v=true", code: deny.BotNotEnrolled},
		{method: "DELETE", target: P + other(".helper") + "?force=true&v=true", code: deny.BotNotEnrolled},
		{method: "POST", target: P + other("") + "/stop?t=30", code: deny.BotNotEnrolled},
		{method: "POST", target: P + other("") + "/restart?t=30", code: deny.BotNotEnrolled},
		{method: "POST", target: P + other(".next") + "/rename?name=" + other(""), code: deny.BotNotEnrolled},
	})
	r.wantNoCalls()
}

// --- the body of the create, on the wire ----------------------------------------------------------

type wireCase struct {
	name  string
	id    string // the recorded body
	sfx   string
	old   string
	new   string
	codes []string
}

// TestRedTeam_RT1_5_CreateBodiesOnTheWire: the mutations of the policy tests,
// this time through the whole gate: refused, and the daemon sees nothing.
func TestRedTeam_RT1_5_CreateBodiesOnTheWire(t *testing.T) {
	r := newRig(t)
	m := r.m
	k, root := m.BotKey, m.VolumeRoot
	hermes := `"` + root + "/" + k + `/hermes:/data/hermes"`
	scratch := `"` + root + "/" + k + `/scratch:/scratch"`
	otherImg := strings.Replace(m.Image, "0123456789abcdef0123456789abcdef", "ffffffffffffffffffffffffffffffff", 1)
	netMode := `"NetworkMode":"` + m.Network + `"`
	apply := "helper-apply-0123456789abcdef"

	c := func(name, id, sfx, old, new string, codes ...string) wireCase {
		return wireCase{name, id, sfx, old, new, codes}
	}
	cases := []wireCase{
		c("privileged", "bot-plain", "", `"Privileged":false`, `"Privileged":true`, deny.JSONValue),
		c("privileged twice", "bot-plain", "", `"Privileged":false`, `"Privileged":false,"Privileged":false`, deny.JSONDuplicateKey),
		c("privileged null", "bot-plain", "", `"Privileged":false`, `"Privileged":null`, deny.JSONType),
		c("privileged as a string", "bot-plain", "", `"Privileged":false`, `"Privileged":"false"`, deny.JSONType),
		c("host network", "bot-plain", "", netMode, `"NetworkMode":"host"`, deny.NetworkMismatch),
		c("no network", "bot-plain", "", netMode, `"NetworkMode":"none"`, deny.NetworkMismatch),
		c("bridge network", "bot-plain", "", netMode, `"NetworkMode":"bridge"`, deny.NetworkMismatch),
		c("network of a container", "bot-plain", "", netMode, `"NetworkMode":"container:abc"`, deny.NetworkMismatch),
		c("networking config", "bot-plain", "", `"HostConfig":`, `"NetworkingConfig":{},"HostConfig":`, deny.JSONUnknownKey),
		c("docker socket as a bind", "bot-plain", "", scratch, `"/var/run/docker.sock:/scratch"`, deny.BindsMismatch),
		c("host root as a bind", "bot-plain", "", hermes, `"/:/data/hermes"`, deny.BindsMismatch),
		c("fourth bind", "bot-plain", "", scratch+`]`, scratch+`,"/var/run/docker.sock:/var/run/docker.sock"]`, deny.BindsMismatch),
		c("image not in the list", "bot-plain", "", `"Image":"`+m.Image, `"Image":"`+otherImg, deny.ImageNotAllowed),
		c("image by tag", "bot-plain", "", `"Image":"`+m.Image, `"Image":"ghcr.io/itkadr-git/myrmidon-hermes:latest`, deny.ImageNotAllowed),
		c("image by id", "bot-plain", "", `"Image":"`+m.Image+`"`, `"Image":"`+m.ImageID+`"`, deny.ImageNotAllowed),
		c("label of another bot", "bot-plain", "", `"myrmidon.bot":"`+k+`"`, `"myrmidon.bot":"`+otherKey+`"`, deny.NameLabelMismatch),
		c("label of another bot on next", "bot-plain", ".next", `"myrmidon.bot":"`+k+`"`, `"myrmidon.bot":"`+otherKey+`"`, deny.NameLabelMismatch),
		c("memory with a fraction", "bot-plain", "", `"Memory":1073741824`, `"Memory":1073741824.5`, deny.JSONType),
		c("memory as a string", "bot-plain", "", `"Memory":1073741824`, `"Memory":"1073741824"`, deny.JSONType),
		c("memory over the ceiling", "bot-plain", "", `"Memory":1073741824`, `"Memory":4294967296`, deny.LimitExceedsEnrolled),
		c("writable rootfs", "bot-plain", "", `"ReadonlyRootfs":true`, `"ReadonlyRootfs":false`, deny.JSONValue),
		c("caps kept", "bot-plain", "", `"CapDrop":["ALL"]`, `"CapDrop":[]`, deny.JSONValue),
		c("seccomp off", "bot-plain", "", `"SecurityOpt":["no-new-privileges"]`, `"SecurityOpt":["seccomp=unconfined"]`, deny.JSONValue),
		c("restart always", "bot-plain", "", `"RestartPolicy":{"Name":"on-failure"}`, `"RestartPolicy":{"Name":"always"}`, deny.JSONValue),
		c("tmpfs with exec", "bot-plain", "", `"Tmpfs":{"/tmp":""}`, `"Tmpfs":{"/tmp":"exec"}`, deny.JSONValue),

		c("env", "bot-plain", "", `{"Image":`, `{"Env":["A=B"],"Image":`, deny.JSONUnknownKey),
		c("cmd", "bot-plain", "", `{"Image":`, `{"Cmd":["sh"],"Image":`, deny.JSONUnknownKey),
		c("entrypoint", "bot-plain", "", `{"Image":`, `{"Entrypoint":["sh"],"Image":`, deny.JSONUnknownKey),
		c("user", "bot-plain", "", `{"Image":`, `{"User":"0","Image":`, deny.JSONUnknownKey),
		c("volumes", "bot-plain", "", `{"Image":`, `{"Volumes":{"/x":{}},"Image":`, deny.JSONUnknownKey),
		c("a key that is a secret", "bot-plain", "", `{"Image":`, `{"canary-key-name":1,"Image":`, deny.JSONUnknownKey),
		c("cap add", "bot-plain", "", `"HostConfig":{`, `"HostConfig":{"CapAdd":["SYS_ADMIN"],`, deny.JSONUnknownKey),
		c("pid mode", "bot-plain", "", `"HostConfig":{`, `"HostConfig":{"PidMode":"host",`, deny.JSONUnknownKey),
		c("devices", "bot-plain", "", `"HostConfig":{`, `"HostConfig":{"Devices":[],`, deny.JSONUnknownKey),
		c("mounts", "bot-plain", "", `"HostConfig":{`, `"HostConfig":{"Mounts":[],`, deny.JSONUnknownKey),
		c("userns", "bot-plain", "", `"HostConfig":{`, `"HostConfig":{"UsernsMode":"host",`, deny.JSONUnknownKey),

		c("prepare: user 1000", "helper-prepare", ".helper", `"User":"0:0"`, `"User":"1000:1000"`, deny.JSONValue),
		c("prepare: recursive chown", "helper-prepare", ".helper", `chown 10001:10001`, `chown -R 10001:10001`, deny.ScriptMismatch),
		c("prepare: appended command", "helper-prepare", ".helper", `done"`, `done; id"`, deny.ScriptMismatch),
		c("prepare: network on", "helper-prepare", ".helper", `"NetworkDisabled":true`, `"NetworkDisabled":false`, deny.JSONValue),
		c("prepare: sys_admin", "helper-prepare", ".helper", `"CapAdd":["CHOWN","FOWNER"]`, `"CapAdd":["CHOWN","FOWNER","SYS_ADMIN"]`, deny.JSONValue),
		c("prepare: docker socket", "helper-prepare", ".helper", hermes, `"/var/run/docker.sock:/data/hermes"`, deny.BindsMismatch),
		c("prepare: image by tag", "helper-prepare", ".helper", `"Image":"`+m.Image+`"`, `"Image":"busybox:latest"`, deny.ImageNotAllowed),
		c("prepare: label of another bot", "helper-prepare", ".helper", `"myrmidon.bot-helper":"`+k+`"`, `"myrmidon.bot-helper":"`+otherKey+`"`, deny.NameLabelMismatch),

		c("apply: image by reference", apply, ".helper", `"Image":"`+m.ImageID+`"`, `"Image":"`+m.Image+`"`, deny.ImageNotAllowed),
		c("apply: nonce with a letter", apply, ".helper", `n=0123456789abcdef`, `n=0123456789abcdeg`, deny.NonceInvalid, deny.ScriptMismatch),
		c("apply: a line added", apply, ".helper", `umask 077\n`, `umask 077\nid\n`, deny.ScriptMismatch, deny.NonceInvalid),
		c("apply: caps", apply, ".helper", `"CapAdd":[]`, `"CapAdd":["CHOWN"]`, deny.JSONValue),
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			b, body := m.FindBody(t, tc.id, tc.sfx)
			if !strings.Contains(string(body), tc.old) {
				t.Fatalf("the recorded body has no %q", tc.old)
			}
			mut := []byte(strings.Replace(string(body), tc.old, tc.new, 1))
			res := r.send("POST", "/v1.45/containers/create?name="+b.Name, jsonHdr, mut)
			wantDenyOneOf(t, res, tc.codes...)
		})
	}

	// The body as a whole.
	_, body := m.FindBody(t, "bot-plain", "")
	create := "/v1.45/containers/create?name=" + r.name("")
	whole := []struct {
		name  string
		body  []byte
		codes []string
	}{
		{"empty", []byte{}, []string{deny.JSONSyntax}},
		{"BOM", append([]byte("\xef\xbb\xbf"), body...), []string{deny.JSONSyntax}},
		{"truncated", body[:len(body)-1], []string{deny.JSONSyntax}},
		{"a second object", append(append([]byte{}, body...), '{', '}'), []string{deny.JSONSyntax}},
		{"null", []byte("null"), []string{deny.JSONType}},
		{"whitespace in front", append([]byte(" "), body...), []string{deny.JSONNotCanonical, deny.JSONSyntax}},
		{"a request behind the body", append(append([]byte{}, body...), []byte("\r\nGET /v1.45/containers/json HTTP/1.1\r\n\r\n")...),
			[]string{deny.JSONSyntax, deny.JSONNotCanonical}},
	}
	for _, w := range whole {
		w := w
		t.Run("body: "+w.name, func(t *testing.T) {
			res := r.send("POST", create, jsonHdr, w.body)
			wantDenyOneOf(t, res, w.codes...)
		})
	}

	r.wantNoCalls()
	if r.created() != 0 {
		t.Errorf("creates: %d", r.created())
	}
}
