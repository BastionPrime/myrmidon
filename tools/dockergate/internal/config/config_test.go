package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
)

const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

const goodJSON = `{
  "listen": "/run/dg/engine.sock",
  "upstream": "/var/run/docker.sock",
  "apiVersion": "1.45",
  "caller": {
    "container": "board",
    "containerLabels": {"com.example.role": "board"},
    "uid": 1000,
    "gid": 1000,
    "argv": ["node", "server.js"]
  },
  "volumeRoot": "/srv/myrmidon-bots",
  "network": "bots-net",
  "images": ["ghcr.io/example/runtime@sha256:` + digest + `"],
  "bots": [
    {"botKey": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "maxMemoryMb": 2048, "maxCpus": 2, "maxPids": 1024}
  ],
  "statsFile": "/run/dg-stats/stats.json"
}`

func mustParse(t *testing.T, s string) *config.Config {
	t.Helper()
	c, _, err := config.Parse([]byte(s))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return c
}

func replace(t *testing.T, s, from, to string) string {
	t.Helper()
	if !strings.Contains(s, from) {
		t.Fatalf("the base config has no %q", from)
	}
	return strings.Replace(s, from, to, 1)
}

func TestParseAccepts(t *testing.T) {
	c := mustParse(t, goodJSON)
	if c.Caller.Mode != config.ModeContainerMainProcess {
		t.Fatalf("default mode %q", c.Caller.Mode)
	}
	if c.Caller.MaxStartDelayTicks != 500 {
		t.Fatalf("default ticks %d", c.Caller.MaxStartDelayTicks)
	}
	if got := c.Limits; got != config.DefaultLimits() {
		t.Fatalf("limits are not the defaults: %+v", got)
	}
	b, ok := c.Bot("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	if !ok || b.MaxMemoryMB != 2048 || b.MaxCPUs != 2 || b.MaxPids != 1024 {
		t.Fatalf("bot: %+v %v", b, ok)
	}
	if _, ok := c.Bot("00000000-0000-4000-8000-000000000000"); ok {
		t.Fatal("an unknown bot was found")
	}
}

func TestParseUIDMode(t *testing.T) {
	s := replace(t, goodJSON, `"argv": ["node", "server.js"]`, `"argv": ["node"], "mode": "uid"`)
	s = replace(t, s, "/srv/myrmidon-bots", "/tmp/ci-bots")
	c := mustParse(t, s)
	if c.Caller.Mode != config.ModeUID {
		t.Fatalf("mode %q", c.Caller.Mode)
	}
}

func TestDefaultLimitsAreTheSpecificationValues(t *testing.T) {
	l := config.DefaultLimits()
	if l.MaxJSONBody != 64<<10 || l.MaxTarBody != 16<<20 {
		t.Fatalf("body limits %d %d", l.MaxJSONBody, l.MaxTarBody)
	}
	if l.UpstreamTimeoutSec != 65 || l.UpstreamStopSec != 65 || l.UpstreamWaitSec != 125 {
		t.Fatalf("timeouts %v %v %v", l.UpstreamTimeoutSec, l.UpstreamStopSec, l.UpstreamWaitSec)
	}
	if l.BodyReadTimeoutSec != 30 || l.MaxInflightUpstream != 32 {
		t.Fatalf("body timeout %v inflight %d", l.BodyReadTimeoutSec, l.MaxInflightUpstream)
	}
	if l.GlobalRate != 50 || l.GlobalBurst != 100 {
		t.Fatalf("global %v %v", l.GlobalRate, l.GlobalBurst)
	}
	if l.InspectRate != 5 || l.InspectBurst != 20 {
		t.Fatalf("inspect %v %v", l.InspectRate, l.InspectBurst)
	}
	if l.RateWindowSec != 600 || l.CreatePerWindow != 30 || l.StartPerWindow != 30 ||
		l.RestartPerWindow != 6 || l.StopPerWindow != 6 || l.PutPerWindow != 30 {
		t.Fatalf("windows %+v", l)
	}
}

func TestLimitsCanBeOverridden(t *testing.T) {
	s := replace(t, goodJSON, `"statsFile"`, `"limits": {"createPerWindow": 3, "upstreamTimeoutSec": 7.5}, "statsFile"`)
	c := mustParse(t, s)
	if c.Limits.CreatePerWindow != 3 || config.Sec(c.Limits.UpstreamTimeoutSec) != 7500*time.Millisecond {
		t.Fatalf("%+v", c.Limits)
	}
	// A key that was left out keeps its default.
	if c.Limits.StartPerWindow != 30 {
		t.Fatalf("start %d", c.Limits.StartPerWindow)
	}
}

// Every one of these makes check-config and serve refuse to start.
func TestParseRefuses(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*testing.T) string
	}{
		{"empty file", func(*testing.T) string { return "" }},
		{"not JSON", func(*testing.T) string { return "listen: x" }},
		{"array", func(*testing.T) string { return "[]" }},
		{"data after the object", func(*testing.T) string { return goodJSON + "{}" }},
		{"unknown top-level key", func(t *testing.T) string { return replace(t, goodJSON, `"network"`, `"netwrok": "x", "network"`) }},
		{"unknown key in caller", func(t *testing.T) string { return replace(t, goodJSON, `"uid": 1000`, `"uid": 1000, "extra": 1`) }},
		{"unknown key in a bot", func(t *testing.T) string {
			return replace(t, goodJSON, `"maxPids": 1024`, `"maxPids": 1024, "maxPid": 1`)
		}},
		{"unknown key in limits", func(t *testing.T) string {
			return replace(t, goodJSON, `"statsFile"`, `"limits": {"maxBody": 1}, "statsFile"`)
		}},
		{"no caller", func(t *testing.T) string {
			s := goodJSON
			i := strings.Index(s, `"caller"`)
			j := strings.Index(s, `"volumeRoot"`)
			return s[:i] + s[j:]
		}},
		{"null caller", func(t *testing.T) string {
			s := goodJSON
			i := strings.Index(s, `"caller"`)
			j := strings.Index(s, `"volumeRoot"`)
			return s[:i] + `"caller": null, ` + s[j:]
		}},
		{"caller uid 0", func(t *testing.T) string { return replace(t, goodJSON, `"uid": 1000`, `"uid": 0`) }},
		{"caller uid missing", func(t *testing.T) string { return replace(t, goodJSON, `"uid": 1000,`, ``) }},
		{"caller without a container", func(t *testing.T) string { return replace(t, goodJSON, `"container": "board",`, ``) }},
		{"caller container is not a name", func(t *testing.T) string { return replace(t, goodJSON, `"container": "board"`, `"container": "a b"`) }},
		{"caller without labels", func(t *testing.T) string {
			return replace(t, goodJSON, `"containerLabels": {"com.example.role": "board"},`, ``)
		}},
		{"caller without argv", func(t *testing.T) string { return replace(t, goodJSON, `"argv": ["node", "server.js"]`, `"argv": []`) }},
		{"caller negative ticks", func(t *testing.T) string {
			return replace(t, goodJSON, `"argv"`, `"maxStartDelayTicks": -1, "argv"`)
		}},
		{"unknown caller mode", func(t *testing.T) string { return replace(t, goodJSON, `"argv"`, `"mode": "any", "argv"`) }},
		{"uid mode with the production volumeRoot", func(t *testing.T) string {
			return replace(t, goodJSON, `"argv": ["node", "server.js"]`, `"argv": ["node"], "mode": "uid"`)
		}},
		{"wrong API version", func(t *testing.T) string { return replace(t, goodJSON, `"1.45"`, `"1.44"`) }},
		{"API version missing", func(t *testing.T) string { return replace(t, goodJSON, `"apiVersion": "1.45",`, ``) }},
		{"relative listen", func(t *testing.T) string { return replace(t, goodJSON, `/run/dg/engine.sock`, `engine.sock`) }},
		{"relative upstream", func(t *testing.T) string { return replace(t, goodJSON, `/var/run/docker.sock`, `docker.sock`) }},
		{"relative statsFile", func(t *testing.T) string { return replace(t, goodJSON, `/run/dg-stats/stats.json`, `stats.json`) }},
		{"volumeRoot with ..", func(t *testing.T) string { return replace(t, goodJSON, `/srv/myrmidon-bots`, `/srv/../etc`) }},
		{"volumeRoot with //", func(t *testing.T) string { return replace(t, goodJSON, `/srv/myrmidon-bots`, `/srv//bots`) }},
		{"volumeRoot with a trailing slash", func(t *testing.T) string { return replace(t, goodJSON, `/srv/myrmidon-bots`, `/srv/bots/`) }},
		{"relative volumeRoot", func(t *testing.T) string { return replace(t, goodJSON, `/srv/myrmidon-bots`, `srv/bots`) }},
		{"network with a slash", func(t *testing.T) string { return replace(t, goodJSON, `bots-net`, `bots/net`) }},
		{"empty network", func(t *testing.T) string { return replace(t, goodJSON, `"bots-net"`, `""`) }},
		{"empty images", func(t *testing.T) string {
			return replace(t, goodJSON, `["ghcr.io/example/runtime@sha256:`+digest+`"]`, `[]`)
		}},
		{"image with a tag instead of a digest", func(t *testing.T) string {
			return replace(t, goodJSON, `ghcr.io/example/runtime@sha256:`+digest, `ghcr.io/example/runtime:latest`)
		}},
		{"image with a tag and a digest", func(t *testing.T) string {
			return replace(t, goodJSON, `runtime@sha256`, `runtime:v1@sha256`)
		}},
		{"image without a repository", func(t *testing.T) string { return replace(t, goodJSON, `ghcr.io/example/runtime@`, `@`) }},
		{"image glob", func(t *testing.T) string {
			return replace(t, goodJSON, `runtime@sha256:`+digest, `runtime*@sha256:`+digest)
		}},
		{"image with a short digest", func(t *testing.T) string { return replace(t, goodJSON, digest, digest[:63]) }},
		{"image with an uppercase digest", func(t *testing.T) string { return replace(t, goodJSON, digest, strings.ToUpper(digest)) }},
		{"image with another algorithm", func(t *testing.T) string { return replace(t, goodJSON, "@sha256:", "@sha512:") }},
		{"image with a space", func(t *testing.T) string { return replace(t, goodJSON, "example/runtime", "example/run time") }},
		{"duplicate images", func(t *testing.T) string {
			img := `"ghcr.io/example/runtime@sha256:` + digest + `"`
			return replace(t, goodJSON, img, img+`, `+img)
		}},
		{"bot key is not a uuid", func(t *testing.T) string {
			return replace(t, goodJSON, `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, `../etc`)
		}},
		{"bot key in uppercase", func(t *testing.T) string {
			return replace(t, goodJSON, `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, `3F2B8C1E-4D5A-4B6C-8D7E-9F0A1B2C3D4E`)
		}},
		{"duplicate bot", func(t *testing.T) string {
			b := `{"botKey": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "maxMemoryMb": 2048, "maxCpus": 2, "maxPids": 1024}`
			return replace(t, goodJSON, b, b+`, `+b)
		}},
		{"zero memory ceiling", func(t *testing.T) string { return replace(t, goodJSON, `"maxMemoryMb": 2048`, `"maxMemoryMb": 0`) }},
		{"negative memory ceiling", func(t *testing.T) string { return replace(t, goodJSON, `"maxMemoryMb": 2048`, `"maxMemoryMb": -1`) }},
		{"zero cpu ceiling", func(t *testing.T) string { return replace(t, goodJSON, `"maxCpus": 2`, `"maxCpus": 0`) }},
		{"zero pids ceiling", func(t *testing.T) string { return replace(t, goodJSON, `"maxPids": 1024`, `"maxPids": 0`) }},
		{"missing ceiling", func(t *testing.T) string { return replace(t, goodJSON, `"maxPids": 1024`, `"maxPids2": 1`) }},
		{"a limit of zero", func(t *testing.T) string {
			return replace(t, goodJSON, `"statsFile"`, `"limits": {"globalRate": 0}, "statsFile"`)
		}},
		{"a negative limit", func(t *testing.T) string {
			return replace(t, goodJSON, `"statsFile"`, `"limits": {"maxInflightUpstream": -5}, "statsFile"`)
		}},
		{"a string where a number belongs", func(t *testing.T) string { return replace(t, goodJSON, `"uid": 1000`, `"uid": "1000"`) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _, err := config.Parse([]byte(tc.mut(t)))
			if err == nil {
				t.Fatalf("accepted: %+v", c)
			}
			if c != nil {
				t.Fatal("a config was returned with the error")
			}
		})
	}
}

func TestParseAcceptsImageForms(t *testing.T) {
	for _, ref := range []string{
		"ghcr.io/example/runtime@sha256:" + digest,
		"registry.example.com:5000/team/app@sha256:" + digest,
		"docker.io/library/name@sha256:" + digest,
		"example/app-1.2_x@sha256:" + digest,
	} {
		s := replace(t, goodJSON, "ghcr.io/example/runtime@sha256:"+digest, ref)
		if _, _, err := config.Parse([]byte(s)); err != nil {
			t.Errorf("%s: %v", ref, err)
		}
	}
}

func TestHashIsStableAndFollowsTheBytes(t *testing.T) {
	_, h1, err := config.Parse([]byte(goodJSON))
	if err != nil {
		t.Fatal(err)
	}
	_, h2, _ := config.Parse([]byte(goodJSON))
	_, h3, err := config.Parse([]byte(goodJSON + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(h1) != 12 || h1 != h2 {
		t.Fatalf("hash %q %q", h1, h2)
	}
	if h3 == h1 {
		t.Fatal("the hash ignores the bytes")
	}
	for _, c := range h1 {
		if !strings.ContainsRune("0123456789abcdef", c) {
			t.Fatalf("hash %q is not hex", h1)
		}
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "config.json")
	if err := os.WriteFile(p, []byte(goodJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	c, h, err := config.Load(p)
	if err != nil || c == nil || h == "" {
		t.Fatalf("Load: %v", err)
	}
	if _, _, err := config.Load(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("a missing file was loaded")
	}
}

func TestSec(t *testing.T) {
	if config.Sec(2) != 2*time.Second || config.Sec(0.5) != 500*time.Millisecond {
		t.Fatal("Sec")
	}
}
