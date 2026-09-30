package gate_test

import (
	"bytes"
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fakedocker"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fixture"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
)

// The allow side: every route of the allowlist (A1 to A12) with the request as
// the driver sends it, the exact request that reaches the daemon, and the exact
// answer that the client gets.

func imageSeg(ref string) string {
	return strings.NewReplacer("@", "%40", ":", "%3A").Replace(ref)
}

func escPath(p string) string { return strings.ReplaceAll(p, "/", "%2F") }

func (r *rig) imageTarget() string { return "/v1.45/images/" + imageSeg(r.m.Image) + "/json" }

func (r *rig) wantURIs(want ...string) {
	r.t.Helper()
	got := r.uris()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		r.t.Errorf("calls to the daemon:\n got  %q\n want %q", got, want)
	}
}

func decodeObject(t testing.TB, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("not a JSON object: %v: %q", err, b)
	}
	return m
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func wantKeys(t testing.TB, what string, m map[string]any, want ...string) {
	t.Helper()
	sort.Strings(want)
	if got := keysOf(m); !reflect.DeepEqual(got, want) {
		t.Errorf("%s: keys %v, want %v", what, got, want)
	}
}

func sub(t testing.TB, m map[string]any, key string) map[string]any {
	t.Helper()
	v, ok := m[key].(map[string]any)
	if !ok {
		t.Fatalf("no object %q in %v", key, keysOf(m))
	}
	return v
}

func wantStatus(t testing.TB, res *resp, status int) {
	t.Helper()
	if res.Status != status {
		t.Errorf("status %d, want %d; body %q", res.Status, status, res.str())
	}
}

func wantNoCanary(t testing.TB, res *resp) {
	t.Helper()
	for _, c := range []string{envCanary, "canary-env-secret", bindCanary, "canary-bind", "secret-health-output",
		"/host/secret/path", "secret-image-cmd"} {
		if strings.Contains(res.str(), c) {
			t.Errorf("the answer carries %q: %q", c, res.str())
		}
	}
}

// wantDaemonHeaders checks that the daemon saw only what dockergate itself puts
// into a request: Host docker and the framing headers.
func (r *rig) wantDaemonHeaders() {
	r.t.Helper()
	for _, c := range r.calls() {
		if c.Host != "docker" {
			r.t.Errorf("%s %s: Host %q, want docker", c.Method, c.URI, c.Host)
		}
		for k := range c.Header {
			switch k {
			case "Content-Type", "Content-Length":
			default:
				r.t.Errorf("%s %s: the daemon got the header %s", c.Method, c.URI, k)
			}
		}
	}
}

// --- A1 ---------------------------------------------------------------------

func TestAllow_A1_ImageInspect(t *testing.T) {
	r := newRig(t)
	res := r.send("GET", r.imageTarget(), nil, nil)
	wantStatus(t, res, 200)
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q", ct)
	}
	want := `{"Id":"` + r.m.ImageID + `","Config":{"Labels":{"` + policy.RuntimeContractLabel + `":"1"}}}`
	if res.str() != want {
		t.Errorf("body %q, want %q", res.str(), want)
	}
	wantNoCanary(t, res)
	r.wantURIs("GET " + r.imageTarget())
	r.wantDaemonHeaders()
}

func TestAllow_A1_MissingImageIsThe404OfTheDaemon(t *testing.T) {
	r := newRig(t)
	r.d.RemoveImage(r.m.Image)
	res := r.send("GET", r.imageTarget(), nil, nil)
	wantStatus(t, res, 404)
	if denyCode(res) != "" {
		t.Errorf("a denial of dockergate, not the answer of the daemon: %q", res.str())
	}
	if !strings.Contains(res.str(), "No such image") {
		t.Errorf("body %q", res.str())
	}
}

// --- A2 and A3 ------------------------------------------------------------------

func TestAllow_A2_ContainerInspectIsTrimmed(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	res := r.send("GET", r.target("", "/json"), nil, nil)
	wantStatus(t, res, 200)
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q", ct)
	}
	wantNoCanary(t, res)

	m := decodeObject(t, res.Body)
	wantKeys(t, "top", m, "Id", "Image", "Config", "State", "HostConfig")
	if m["Id"] != r.id("") || m["Image"] != r.m.ImageID {
		t.Errorf("Id/Image: %v %v", m["Id"], m["Image"])
	}
	cfg := sub(t, m, "Config")
	wantKeys(t, "Config", cfg, "Image", "Labels")
	if cfg["Image"] != r.m.Image {
		t.Errorf("Config.Image %v", cfg["Image"])
	}
	if labels := sub(t, cfg, "Labels"); labels["myrmidon.bot"] != r.key() {
		t.Errorf("labels %v", labels)
	}
	state := sub(t, m, "State")
	wantKeys(t, "State", state, "Status", "ExitCode", "Health")
	if state["Status"] != "running" {
		t.Errorf("State.Status %v", state["Status"])
	}
	health := sub(t, state, "Health")
	wantKeys(t, "Health", health, "Status")
	if health["Status"] != "healthy" {
		t.Errorf("Health.Status %v", health["Status"])
	}
	hc := sub(t, m, "HostConfig")
	wantKeys(t, "HostConfig", hc, "Memory", "NanoCpus", "PidsLimit", "NetworkMode")
	if hc["Memory"] != float64(1<<30) || hc["NanoCpus"] != float64(1_000_000_000) ||
		hc["PidsLimit"] != float64(512) || hc["NetworkMode"] != r.m.Network {
		t.Errorf("HostConfig %v", hc)
	}
	r.wantURIs("GET " + r.target("", "/json"))
	r.wantDaemonHeaders()
}

func TestAllow_A2_WithoutHealthTheKeyIsAbsent(t *testing.T) {
	r := newRig(t)
	r.seedMain("exited")
	r.d.Modify(r.name(""), func(c *fakedocker.Container) { c.Health = "" })
	res := r.send("GET", r.target("", "/json"), nil, nil)
	wantStatus(t, res, 200)
	state := sub(t, decodeObject(t, res.Body), "State")
	wantKeys(t, "State", state, "Status", "ExitCode")
}

func TestAllow_A2_MissingContainerIs404(t *testing.T) {
	r := newRig(t)
	res := r.send("GET", r.target("", "/json"), nil, nil)
	wantStatus(t, res, 404)
	if res.str() != `{"message":"No such container"}` {
		t.Errorf("body %q", res.str())
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q", ct)
	}
	r.wantURIs("GET " + r.target("", "/json"))
	if l := r.lastDecision(); l.Decision != "allow" || l.UpstreamStatus != 404 {
		t.Errorf("log: %+v", l)
	}
}

func TestAllow_A3_AppliedMarker(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	marker := []byte("marker-tar-bytes\x00\x01\x02")
	r.d.Modify(r.name(""), func(c *fakedocker.Container) { c.Marker = marker })
	id := r.id("")
	target := r.target("", "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json")
	res := r.send("GET", target, nil, nil)
	wantStatus(t, res, 200)
	if !bytes.Equal(res.Body, marker) {
		t.Errorf("body %q", res.Body)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/x-tar" {
		t.Errorf("Content-Type %q", ct)
	}
	if v := res.Header.Get("X-Docker-Container-Path-Stat"); v != "" {
		t.Errorf("the stat header of the daemon was passed on: %q", v)
	}
	r.wantURIs("GET "+r.target("", "/json"),
		"GET /v1.45/containers/"+id+"/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json")
	r.wantDaemonHeaders()
}

func TestAllow_A3_NoMarkerIsThe404OfTheDaemon(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	res := r.send("GET", r.target("", "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json"), nil, nil)
	wantStatus(t, res, 404)
	if denyCode(res) != "" || !strings.Contains(res.str(), "Could not find") {
		t.Errorf("body %q", res.str())
	}
}

// --- A4 ---------------------------------------------------------------------------

// The create bodies that the board really produces (contract/testdata, written
// by the TypeScript of the driver) all pass, and the daemon gets the same bytes.
func TestAllow_A4_RecordedBodies(t *testing.T) {
	m := fixture.Load(t)
	n := 0
	for _, b := range m.Bodies {
		if b.ID == "helper-prepare-by-id" {
			continue
		}
		n++
		t.Run(strings.TrimPrefix(b.File, "bodies/"), func(t *testing.T) {
			r := newRig(t)
			sfx := strings.TrimPrefix(b.Name, r.name(""))
			if sfx == ".next" || b.Form == "helper-apply" {
				r.seedMain("running")
			}
			body := fixture.Read(t, b.File)
			res := r.send("POST", "/v1.45/containers/create?name="+b.Name, jsonHdr, body)
			wantStatus(t, res, 201)
			if want := `{"Id":"` + r.id(sfx) + `","Warnings":[]}`; res.str() != want {
				t.Errorf("body %q, want %q", res.str(), want)
			}
			wantNoCanary(t, res)

			c, ok := r.d.Get(b.Name)
			if !ok {
				t.Fatal("the container was not created")
			}
			if !bytes.Equal(c.Create, body) {
				t.Errorf("the daemon got another body than the recorded one:\n got  %s\n want %s", c.Create, body)
			}
			calls := r.calls()
			last := calls[len(calls)-1]
			if last.Method != "POST" || last.URI != "/v1.45/containers/create?name="+b.Name {
				t.Errorf("last call: %s %s", last.Method, last.URI)
			}
			for _, c := range calls[:len(calls)-1] {
				if c.Method != "GET" {
					t.Errorf("before the create: %s %s", c.Method, c.URI)
				}
			}
			if r.created() != 1 {
				t.Errorf("creates: %d", r.created())
			}
			r.wantDaemonHeaders()
			if last.Header.Get("Content-Type") != "application/json" {
				t.Errorf("Content-Type to the daemon: %q", last.Header.Get("Content-Type"))
			}
		})
	}
	if n != len(m.Bodies)-1 {
		t.Fatalf("checked %d bodies of %d", n, len(m.Bodies))
	}
}

func TestAllow_A4_PrepareByImageIdIsDenied(t *testing.T) {
	r := newRig(t)
	m := r.m
	_, body := m.FindBody(t, "helper-prepare-by-id", ".helper")
	res := r.send("POST", "/v1.45/containers/create?name="+r.name(".helper"), jsonHdr, body)
	wantDeny(t, res, "image_not_allowed")
	r.wantNoCalls()
}

// A4 with an extra mount: a source from mountSources reaches the daemon as the
// driver sent it (read-only), and a source outside the list never reaches it.
func TestAllow_A4_ExtraMounts(t *testing.T) {
	shared := "/srv/shared/sources"
	addExtra := func(t *testing.T, r *rig) []byte {
		t.Helper()
		_, body := r.m.FindBody(t, "bot-plain", "")
		last := `"` + r.m.VolumeRoot + "/" + r.m.BotKey + `/scratch:/scratch"]`
		if !bytes.Contains(body, []byte(last)) {
			t.Fatalf("the recorded body has no %q", last)
		}
		return bytes.Replace(body, []byte(last), []byte(`"`+r.m.VolumeRoot+"/"+r.m.BotKey+`/scratch:/scratch","`+shared+`:`+shared+`:ro"]`), 1)
	}

	t.Run("an allowlisted source is forwarded to the daemon", func(t *testing.T) {
		r := newRig(t, withConfig(func(c *config.Config) { c.MountSources = []string{shared} }))
		body := addExtra(t, r)
		res := r.send("POST", "/v1.45/containers/create?name="+r.name(""), jsonHdr, body)
		wantStatus(t, res, 201)
		wantNoCanary(t, res)
		c, ok := r.d.Get(r.name(""))
		if !ok {
			t.Fatal("the container was not created")
		}
		if !bytes.Equal(c.Create, body) {
			t.Errorf("the daemon got another body than the request:\n got  %s\n want %s", c.Create, body)
		}
	})

	t.Run("a source outside mountSources is denied and nothing reaches the daemon", func(t *testing.T) {
		r := newRig(t)
		body := addExtra(t, r)
		res := r.send("POST", "/v1.45/containers/create?name="+r.name(""), jsonHdr, body)
		wantDeny(t, res, "mount_source_not_allowed")
		r.wantNoCalls()
	})
}

// --- A5 ---------------------------------------------------------------------------

func TestAllow_A5_RecordedArchives(t *testing.T) {
	m := fixture.Load(t)
	for _, a := range m.Archives {
		a := a
		t.Run(a.ID+strings.ReplaceAll(a.MountPath, "/", "_"), func(t *testing.T) {
			r := newRig(t)
			r.seedApplyHelper(a.Nonce, "created")
			id := r.id(".helper")
			tarBytes := fixture.ArchiveBytes(t, a)
			path := "/archive?path=" + escPath(a.MountPath) + "&noOverwriteDirNonDir=true"
			res := r.send("PUT", r.target(".helper", path), tarHdr, tarBytes)
			wantStatus(t, res, 200)

			c, _ := r.d.Get(r.name(".helper"))
			if len(c.Uploads) != 1 {
				t.Fatalf("uploads: %d", len(c.Uploads))
			}
			if c.Uploads[0].Path != a.MountPath {
				t.Errorf("upload path %q", c.Uploads[0].Path)
			}
			if !bytes.Equal(c.Uploads[0].Body, tarBytes) {
				t.Errorf("the daemon got another tar than the recorded one (%d bytes, want %d)", len(c.Uploads[0].Body), len(tarBytes))
			}
			r.wantURIs("GET "+r.target(".helper", "/json"), "PUT /v1.45/containers/"+id+path)
			r.wantDaemonHeaders()
			for _, call := range r.calls() {
				if call.Method == "PUT" && call.Header.Get("Content-Type") != "application/x-tar" {
					t.Errorf("Content-Type to the daemon: %q", call.Header.Get("Content-Type"))
				}
			}
		})
	}
}

// --- A6 to A12 -------------------------------------------------------------------

func TestAllow_A6_StartMain(t *testing.T) {
	r := newRig(t)
	r.seedMain("created")
	id := r.id("")
	res := r.send("POST", r.target("", "/start"), nil, nil)
	wantStatus(t, res, 204)
	if c, _ := r.d.Get(r.name("")); c.Status != "running" {
		t.Errorf("status %q", c.Status)
	}
	r.wantURIs("GET "+r.target("", "/json"), "POST /v1.45/containers/"+id+"/start")
	r.wantDaemonHeaders()
}

func TestAllow_A6_StartOfRunningMainIsThe304OfTheDaemon(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	res := r.send("POST", r.target("", "/start"), nil, nil)
	wantStatus(t, res, 304)
	if len(res.Body) != 0 {
		t.Errorf("body %q", res.Body)
	}
}

func TestAllow_A6_StartHelper(t *testing.T) {
	r := newRig(t)
	r.seedPrepareHelper("created")
	id := r.id(".helper")
	res := r.send("POST", r.target(".helper", "/start"), nil, nil)
	wantStatus(t, res, 204)
	r.wantURIs("GET "+r.target(".helper", "/json"), "POST /v1.45/containers/"+id+"/start")
}

func TestAllow_A7_WaitOfExitedHelper(t *testing.T) {
	r := newRig(t)
	r.seedPrepareHelper("exited")
	id := r.id(".helper")
	res := r.send("POST", r.target(".helper", "/wait?condition=not-running"), nil, nil)
	wantStatus(t, res, 200)
	if res.str() != `{"StatusCode":0}` {
		t.Errorf("body %q", res.str())
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q", ct)
	}
	r.wantURIs("GET "+r.target(".helper", "/json"), "POST /v1.45/containers/"+id+"/wait?condition=not-running")
	r.wantDaemonHeaders()
}

// The wait stays open while the helper runs and ends with the answer of the
// daemon when it stops.
func TestAllow_A7_WaitLastsUntilTheHelperStops(t *testing.T) {
	r := newRig(t)
	r.seedPrepareHelper("running")
	c := r.dial()
	defer c.close()
	c.write(buildRaw("POST", r.target(".helper", "/wait?condition=not-running"), nil, nil))

	_ = c.c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, err := c.br.Peek(1); err == nil {
		t.Fatal("an answer came while the helper was running")
	}
	r.d.Modify(r.name(".helper"), func(ct *fakedocker.Container) { ct.Status = "exited"; ct.ExitCode = 3 })
	res := c.read("POST")
	wantStatus(t, res, 200)
	if res.str() != `{"StatusCode":3}` {
		t.Errorf("body %q", res.str())
	}
}

func TestAllow_A8_HelperLog(t *testing.T) {
	r := newRig(t)
	r.seedPrepareHelper("exited")
	r.d.Modify(r.name(".helper"), func(c *fakedocker.Container) { c.Logs = []byte("hello") })
	id := r.id(".helper")
	res := r.send("GET", r.target(".helper", "/logs?stdout=true&stderr=true&tail=20"), nil, nil)
	wantStatus(t, res, 200)
	want := append([]byte{1, 0, 0, 0, 0, 0, 0, 5}, "hello"...)
	if !bytes.Equal(res.Body, want) {
		t.Errorf("body %q", res.Body)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/vnd.docker.multiplexed-stream" {
		t.Errorf("Content-Type %q", ct)
	}
	r.wantURIs("GET "+r.target(".helper", "/json"), "GET /v1.45/containers/"+id+"/logs?stdout=true&stderr=true&tail=20")
	r.wantDaemonHeaders()
}

func TestAllow_A9_DeleteHelper(t *testing.T) {
	r := newRig(t)
	r.seedPrepareHelper("exited")
	id := r.id(".helper")
	res := r.send("DELETE", r.target(".helper", "?force=true&v=true"), nil, nil)
	wantStatus(t, res, 204)
	if _, ok := r.d.Get(r.name(".helper")); ok {
		t.Error("the helper is still there")
	}
	r.wantURIs("GET "+r.target(".helper", "/json"), "DELETE /v1.45/containers/"+id+"?force=true&v=true")
	r.wantDaemonHeaders()
}

func TestAllow_A9_DeleteNext(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	r.seedNext("created")
	id := r.id(".next")
	res := r.send("DELETE", r.target(".next", "?force=true&v=true"), nil, nil)
	wantStatus(t, res, 204)
	if _, ok := r.d.Get(r.name(".next")); ok {
		t.Error(".next is still there")
	}
	if _, ok := r.d.Get(r.name("")); !ok {
		t.Error("the main container is gone")
	}
	r.wantURIs("GET "+r.target(".next", "/json"), "DELETE /v1.45/containers/"+id+"?force=true&v=true")
}

func TestAllow_A9_DeleteMainOfARecreate(t *testing.T) {
	r := newRig(t)
	r.seedMain("exited")
	r.seedNext("created")
	id := r.id("")
	res := r.send("DELETE", r.target("", "?force=true&v=true"), nil, nil)
	wantStatus(t, res, 204)
	if _, ok := r.d.Get(r.name("")); ok {
		t.Error("the main container is still there")
	}
	r.wantURIs("GET "+r.target("", "/json"), "GET "+r.target(".next", "/json"),
		"DELETE /v1.45/containers/"+id+"?force=true&v=true")
}

func TestAllow_A9_DeleteMissingIs404(t *testing.T) {
	r := newRig(t)
	res := r.send("DELETE", r.target(".helper", "?force=true&v=true"), nil, nil)
	wantStatus(t, res, 404)
	if res.str() != `{"message":"No such container"}` {
		t.Errorf("body %q", res.str())
	}
}

func TestAllow_A10_StopOfARecreate(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	r.seedNext("created")
	id := r.id("")
	res := r.send("POST", r.target("", "/stop?t=30"), nil, nil)
	wantStatus(t, res, 204)
	if c, _ := r.d.Get(r.name("")); c.Status != "exited" {
		t.Errorf("status %q", c.Status)
	}
	r.wantURIs("GET "+r.target("", "/json"), "GET "+r.target(".next", "/json"),
		"POST /v1.45/containers/"+id+"/stop?t=30")
	r.wantDaemonHeaders()
}

func TestAllow_A11_Restart(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	id := r.id("")
	res := r.send("POST", r.target("", "/restart?t=30"), nil, nil)
	wantStatus(t, res, 204)
	r.wantURIs("GET "+r.target("", "/json"), "POST /v1.45/containers/"+id+"/restart?t=30")
	r.wantDaemonHeaders()
}

func TestAllow_A12_RenameNextToMain(t *testing.T) {
	r := newRig(t)
	r.seedNext("created")
	id := r.id(".next")
	res := r.send("POST", r.target(".next", "/rename?name="+r.name("")), nil, nil)
	wantStatus(t, res, 204)
	c, ok := r.d.Get(r.name(""))
	if !ok || c.ID != id {
		t.Errorf("the main name does not lead to the former .next: %v %s", ok, c.ID)
	}
	r.wantURIs("GET "+r.target(".next", "/json"), "GET "+r.target("", "/json"),
		"POST /v1.45/containers/"+id+"/rename?name="+r.name(""))
	r.wantDaemonHeaders()
}

// --- what the daemon is not told -------------------------------------------------------

// Whatever headers a caller sends, the daemon gets Host docker and the framing
// headers only.
func TestAllow_ClientHeadersDoNotReachTheDaemon(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	junk := map[string]string{
		"Authorization":   "Bearer canary-token",
		"X-Registry-Auth": "canary-registry",
		"User-Agent":      "canary-agent",
		"Accept-Encoding": "gzip",
		"X-Forwarded-For": "203.0.113.9",
		"Cookie":          "canary=1",
	}
	res := r.send("GET", r.target("", "/json"), junk, nil)
	wantStatus(t, res, 200)

	_, body := r.m.FindBody(t, "bot-plain", ".next")
	hdr := map[string]string{"Content-Type": "application/json"}
	for k, v := range junk {
		hdr[k] = v
	}
	res = r.send("POST", "/v1.45/containers/create?name="+r.name(".next"), hdr, body)
	wantStatus(t, res, 201)

	r.wantDaemonHeaders()
	for _, c := range r.d.Calls() {
		for k, vs := range c.Header {
			for _, v := range vs {
				if strings.Contains(v, "canary") || strings.Contains(v, "203.0.113.9") {
					t.Errorf("%s %s: header %s carries %q", c.Method, c.URI, k, v)
				}
			}
		}
	}
}
