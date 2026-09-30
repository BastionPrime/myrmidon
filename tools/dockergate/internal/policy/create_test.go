package policy_test

import (
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fixture"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
)

const otherKey = "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff"

// env is the environment of the recorded bodies with roomy ceilings.
func env(m *fixture.Manifest) *policy.Env {
	return &policy.Env{
		VolumeRoot:  m.VolumeRoot,
		Network:     m.Network,
		Images:      map[string]struct{}{m.Image: {}},
		MaxMemoryMB: 2048,
		MaxCPUs:     4,
		MaxPids:     2048,
	}
}

func createRoute(t *testing.T, name string) *route.Route {
	t.Helper()
	r, err := route.Parse("POST", "/v1.45/containers/create?name="+name, nil)
	if err != nil {
		t.Fatalf("route for %s: %s", name, err.Code)
	}
	return r
}

// replace changes the first occurrence of old and fails the test when there is
// none, so that a mutation cannot silently miss.
func replace(t *testing.T, body []byte, old, repl string) []byte {
	t.Helper()
	s := string(body)
	if !strings.Contains(s, old) {
		t.Fatalf("mutation target %q is not in the body", old)
	}
	return []byte(strings.Replace(s, old, repl, 1))
}

func replaceAll(t *testing.T, body []byte, old, repl string) []byte {
	t.Helper()
	s := string(body)
	if !strings.Contains(s, old) {
		t.Fatalf("mutation target %q is not in the body", old)
	}
	return []byte(strings.ReplaceAll(s, old, repl))
}

func wantDeny(t *testing.T, c *policy.Create, err *deny.Error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("accepted (form %v), want %s", c.Form, code)
	}
	if err.Code != code {
		t.Fatalf("denied as %s (field %q, detail %q), want %s", err.Code, err.Field, err.Detail, code)
	}
}

// Every recorded body of the real driver is accepted, and the body that goes
// to the daemon is the recorded one, byte for byte.
func TestRecordedBodiesAreCanonical(t *testing.T) {
	m := fixture.Load(t)
	for _, b := range m.Bodies {
		if b.ID == "helper-prepare-by-id" {
			continue // negative case, below
		}
		t.Run(b.ID+strings.TrimPrefix(b.Name, "myrmidon-bot-"+m.BotKey), func(t *testing.T) {
			body := m.Body(t, b)
			c, err := policy.ParseCreate(body, createRoute(t, b.Name), env(m))
			if err != nil {
				t.Fatalf("denied: %s (field %q, detail %q)", err.Code, err.Field, err.Detail)
			}
			if string(c.Body) != string(body) {
				t.Fatal("the canonical body differs from the recorded one")
			}
			if c.BotKey != m.BotKey {
				t.Fatalf("BotKey %q", c.BotKey)
			}
			switch b.Form {
			case "bot":
				if c.Form != policy.FormBot || c.Image != m.Image {
					t.Fatalf("form %v image %q", c.Form, c.Image)
				}
			case "helper-prepare":
				if c.Form != policy.FormHelperPrepare || c.Image != m.Image {
					t.Fatalf("form %v image %q", c.Form, c.Image)
				}
			case "helper-apply":
				if c.Form != policy.FormHelperApply || c.Image != m.ImageID || c.Nonce != b.Nonce {
					t.Fatalf("form %v image %q nonce %q", c.Form, c.Image, c.Nonce)
				}
			default:
				t.Fatalf("unknown form %q in the manifest", b.Form)
			}
		})
	}
}

func TestPrepareByImageIDIsDenied(t *testing.T) {
	m := fixture.Load(t)
	b, body := m.FindBody(t, "helper-prepare-by-id", ".helper")
	c, err := policy.ParseCreate(body, createRoute(t, b.Name), env(m))
	wantDeny(t, c, err, deny.ImageNotAllowed)
}

func TestFormString(t *testing.T) {
	if policy.FormBot.String() != "bot" || policy.FormHelperPrepare.String() != "helper.prepare" || policy.FormHelperApply.String() != "helper.apply" {
		t.Fatal("Form.String")
	}
}

func TestBinds(t *testing.T) {
	got := policy.Binds("/root", "K")
	want := []string{"/root/K/hermes:/data/hermes", "/root/K/workspace:/workspace", "/root/K/scratch:/scratch"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("binds: %v", got)
	}
}

type mutation struct {
	name     string
	old, new string
	all      bool
	code     string
}

func runMutations(t *testing.T, id, suffix string, cases []mutation) {
	t.Helper()
	m := fixture.Load(t)
	b, body := m.FindBody(t, id, suffix)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var mut []byte
			if tc.all {
				mut = replaceAll(t, body, tc.old, tc.new)
			} else {
				mut = replace(t, body, tc.old, tc.new)
			}
			c, err := policy.ParseCreate(mut, createRoute(t, b.Name), env(m))
			wantDeny(t, c, err, tc.code)
		})
	}
}

// The schema of the bot form: every field of the driver's body, changed.
func TestBotBodyMutations(t *testing.T) {
	m := fixture.Load(t)
	k := m.BotKey
	img := m.Image
	otherImg := strings.Replace(img, "0123456789abcdef0123456789abcdef", "ffffffffffffffffffffffffffffffff", 1)
	runMutations(t, "bot-plain", "", []mutation{
		{"image not in the list", `"Image":"` + img, `"Image":"` + otherImg, false, deny.ImageNotAllowed},
		{"image by tag", `"Image":"` + img, `"Image":"ghcr.io/itkadr-git/myrmidon-hermes:latest`, false, deny.ImageNotAllowed},
		{"image by id", `"Image":"` + img + `"`, `"Image":"` + m.ImageID + `"`, false, deny.ImageNotAllowed},
		{"empty image", `"Image":"` + img + `"`, `"Image":""`, false, deny.ImageNotAllowed},
		{"image is a number", `"Image":"` + img + `"`, `"Image":1`, false, deny.JSONType},
		{"label of another bot", `"myrmidon.bot":"` + k + `"`, `"myrmidon.bot":"` + otherKey + `"`, false, deny.NameLabelMismatch},
		{"label empty", `"myrmidon.bot":"` + k + `"`, `"myrmidon.bot":""`, false, deny.NameLabelMismatch},
		{"image label differs", `"myrmidon.image":"` + img + `"`, `"myrmidon.image":"` + otherImg + `"`, false, deny.JSONValue},
		{"label renamed", `"myrmidon.image":`, `"myrmidon.imagf":`, false, deny.JSONUnknownKey},
		{"extra label", `"myrmidon.image":`, `"x":"y","myrmidon.image":`, false, deny.JSONUnknownKey},
		{"labels not an object", `"Labels":{"myrmidon.bot":"` + k + `","myrmidon.image":"` + img + `"}`, `"Labels":[]`, false, deny.JSONType},

		{"privileged", `"Privileged":false`, `"Privileged":true`, false, deny.JSONValue},
		{"privileged as string", `"Privileged":false`, `"Privileged":"false"`, false, deny.JSONType},
		{"cap drop other", `"CapDrop":["ALL"]`, `"CapDrop":["NET_ADMIN"]`, false, deny.JSONValue},
		{"cap drop empty", `"CapDrop":["ALL"]`, `"CapDrop":[]`, false, deny.JSONValue},
		{"cap drop extra", `"CapDrop":["ALL"]`, `"CapDrop":["ALL","CHOWN"]`, false, deny.JSONValue},
		{"security opt unconfined", `"SecurityOpt":["no-new-privileges"]`, `"SecurityOpt":["seccomp=unconfined"]`, false, deny.JSONValue},
		{"security opt empty", `"SecurityOpt":["no-new-privileges"]`, `"SecurityOpt":[]`, false, deny.JSONValue},
		{"writable rootfs", `"ReadonlyRootfs":true`, `"ReadonlyRootfs":false`, false, deny.JSONValue},
		{"tmpfs exec", `"Tmpfs":{"/tmp":""}`, `"Tmpfs":{"/tmp":"exec"}`, false, deny.JSONValue},
		{"tmpfs other path", `"Tmpfs":{"/tmp":""}`, `"Tmpfs":{"/host":""}`, false, deny.JSONUnknownKey},
		{"tmpfs two paths", `"Tmpfs":{"/tmp":""}`, `"Tmpfs":{"/tmp":"","/run":""}`, false, deny.JSONUnknownKey},
		{"no init", `"Init":true`, `"Init":false`, false, deny.JSONValue},
		{"restart always", `"RestartPolicy":{"Name":"on-failure"}`, `"RestartPolicy":{"Name":"always"}`, false, deny.JSONValue},
		{"restart retry count", `"RestartPolicy":{"Name":"on-failure"}`, `"RestartPolicy":{"Name":"on-failure","MaximumRetryCount":5}`, false, deny.JSONUnknownKey},

		{"missing privileged", `,"Privileged":false`, ``, false, deny.JSONValue},
		{"missing labels key", `"Labels":`, `"Labelz":`, false, deny.JSONUnknownKey},
	})
}

// RT1_6: the network is the configured one and nothing else.
func TestRedTeam_RT1_6_Network(t *testing.T) {
	m := fixture.Load(t)
	runMutations(t, "bot-plain", "", []mutation{
		{"host network", `"NetworkMode":"` + m.Network + `"`, `"NetworkMode":"host"`, false, deny.NetworkMismatch},
		{"none", `"NetworkMode":"` + m.Network + `"`, `"NetworkMode":"none"`, false, deny.NetworkMismatch},
		{"bridge", `"NetworkMode":"` + m.Network + `"`, `"NetworkMode":"bridge"`, false, deny.NetworkMismatch},
		{"container network", `"NetworkMode":"` + m.Network + `"`, `"NetworkMode":"container:abc"`, false, deny.NetworkMismatch},
		{"other network", `"NetworkMode":"` + m.Network + `"`, `"NetworkMode":"other-net"`, false, deny.NetworkMismatch},
		{"prefix of the network", `"NetworkMode":"` + m.Network + `"`, `"NetworkMode":"` + m.Network + `x"`, false, deny.NetworkMismatch},
		{"empty", `"NetworkMode":"` + m.Network + `"`, `"NetworkMode":""`, false, deny.NetworkMismatch},
		{"case", `"NetworkMode":"` + m.Network + `"`, `"NetworkMode":"MYRMIDON-BOTS"`, false, deny.NetworkMismatch},
		{"networking config", `"HostConfig":`, `"NetworkingConfig":{},"HostConfig":`, false, deny.JSONUnknownKey},
	})
}

func TestBotBindsMismatch(t *testing.T) {
	m := fixture.Load(t)
	k, root := m.BotKey, m.VolumeRoot
	hermes := root + "/" + k + "/hermes:/data/hermes"
	work := root + "/" + k + "/workspace:/workspace"
	scratch := root + "/" + k + "/scratch:/scratch"
	runMutations(t, "bot-plain", "", []mutation{
		{"host root", `"` + hermes + `"`, `"/:/data/hermes"`, false, deny.BindsMismatch},
		{"etc", `"` + hermes + `"`, `"/etc:/data/hermes"`, false, deny.BindsMismatch},
		{"docker socket", `"` + scratch + `"`, `"/var/run/docker.sock:/scratch"`, false, deny.BindsMismatch},
		{"fourth bind", `"` + scratch + `"]`, `"` + scratch + `","/var/run/docker.sock:/var/run/docker.sock"]`, false, deny.BindsMismatch},
		{"read-only flag", `"` + work + `"`, `"` + work + `:ro"`, false, deny.BindsMismatch},
		{"another bot", `"` + hermes + `"`, `"` + root + "/" + otherKey + `/hermes:/data/hermes"`, false, deny.BindsMismatch},
		{"another root", `"` + hermes + `"`, `"/srv/other/` + k + `/hermes:/data/hermes"`, false, deny.BindsMismatch},
		{"traversal", `"` + hermes + `"`, `"` + root + "/" + k + `/../x/hermes:/data/hermes"`, false, deny.BindsMismatch},
		{"trailing slash", `"` + hermes + `"`, `"` + hermes + `/"`, false, deny.BindsMismatch},
		{"swapped order", `"` + hermes + `","` + work + `"`, `"` + work + `","` + hermes + `"`, false, deny.BindsMismatch},
		{"one bind missing", `,"` + scratch + `"`, ``, false, deny.BindsMismatch},
		{"no binds", `"Binds":["` + hermes + `","` + work + `","` + scratch + `"]`, `"Binds":[]`, false, deny.BindsMismatch},
		{"binds as string", `"Binds":["` + hermes + `","` + work + `","` + scratch + `"]`, `"Binds":"x"`, false, deny.JSONType},
		{"bind is a number", `"` + scratch + `"`, `1`, false, deny.JSONType},
	})
}

// The bot's extra read-only mounts: the three fixed binds stay first and in
// order, and every extra one is checked against the instance allowlist.
func TestBotExtraMounts(t *testing.T) {
	m := fixture.Load(t)
	k, root := m.BotKey, m.VolumeRoot
	scratch := root + "/" + k + "/scratch:/scratch"
	tail := `"` + scratch + `"]`
	shared := "/srv/shared/sources"

	withEnv := func(sources ...string) *policy.Env {
		e := env(m)
		e.MountSources = sources
		return e
	}
	// bodyWith returns the recorded bot body carrying one extra bind.
	bodyWith := func(t *testing.T, bind string) []byte {
		t.Helper()
		_, body := m.FindBody(t, "bot-plain", "")
		return replace(t, body, tail, `"`+scratch+`","`+bind+`"]`)
	}

	t.Run("an allowlisted read-only mount is accepted and kept canonical", func(t *testing.T) {
		body := bodyWith(t, shared+":"+shared+":ro")
		c, err := policy.ParseCreate(body, createRoute(t, "myrmidon-bot-"+k), withEnv(shared, "/srv/shared/tools"))
		if err != nil {
			t.Fatalf("denied: %s (field %q, detail %q)", err.Code, err.Field, err.Detail)
		}
		if string(c.Body) != string(body) {
			t.Fatal("the canonical body differs from the request")
		}
		if !strings.Contains(string(c.Body), shared+":"+shared+`:ro`) {
			t.Fatalf("the extra mount is missing from the canonical body: %s", c.Body)
		}
	})

	t.Run("a source outside mountSources is denied", func(t *testing.T) {
		body := bodyWith(t, "/srv/elsewhere/x:/srv/elsewhere/x:ro")
		c, err := policy.ParseCreate(body, createRoute(t, "myrmidon-bot-"+k), withEnv(shared))
		wantDeny(t, c, err, deny.MountSourceNotAllowed)
	})

	t.Run("a sibling of an allowlisted source is denied (no prefix rule)", func(t *testing.T) {
		body := bodyWith(t, shared+"/deeper:"+shared+"/deeper:ro")
		c, err := policy.ParseCreate(body, createRoute(t, "myrmidon-bot-"+k), withEnv(shared))
		wantDeny(t, c, err, deny.MountSourceNotAllowed)
	})

	t.Run("with no mountSources every extra mount is denied", func(t *testing.T) {
		body := bodyWith(t, shared+":"+shared+":ro")
		c, err := policy.ParseCreate(body, createRoute(t, "myrmidon-bot-"+k), withEnv())
		wantDeny(t, c, err, deny.MountSourceNotAllowed)
	})

	t.Run("a writable extra mount is denied", func(t *testing.T) {
		body := bodyWith(t, shared+":"+shared)
		c, err := policy.ParseCreate(body, createRoute(t, "myrmidon-bot-"+k), withEnv(shared))
		wantDeny(t, c, err, deny.BindsMismatch)
	})

	t.Run("an extra mount over a reserved path is denied", func(t *testing.T) {
		for _, target := range []string{"/workspace", "/workspace/shared", "/data/hermes", "/scratch", "/tmp", "/tmp/x", "relative", "/", "/x/../y"} {
			body := bodyWith(t, shared+":"+target+":ro")
			c, err := policy.ParseCreate(body, createRoute(t, "myrmidon-bot-"+k), withEnv(shared))
			wantDeny(t, c, err, deny.BindsMismatch)
		}
	})

	t.Run("the same target twice is denied", func(t *testing.T) {
		_, body := m.FindBody(t, "bot-plain", "")
		body = replace(t, body, tail, `"`+scratch+`","`+shared+`:`+shared+`:ro","/srv/shared/tools:`+shared+`:ro"]`)
		c, err := policy.ParseCreate(body, createRoute(t, "myrmidon-bot-"+k), withEnv(shared, "/srv/shared/tools"))
		wantDeny(t, c, err, deny.BindsMismatch)
	})

	t.Run("a helper may not carry an extra mount", func(t *testing.T) {
		hb, hbody := m.FindBody(t, "helper-apply-0123456789abcdef", ".helper")
		c, err := policy.ParseCreate(hbody, createRoute(t, hb.Name), withEnv(shared))
		if err != nil {
			t.Fatalf("the recorded helper body was denied: %s", err.Code)
		}
		if strings.Count(string(c.Body), shared) != 0 {
			t.Fatal("a helper body must not carry an extra mount")
		}
		helperScratch := root + "/" + k + "/scratch:/scratch"
		mut := replace(t, hbody, `"`+helperScratch+`"]`, `"`+helperScratch+`","`+shared+`:`+shared+`:ro"]`)
		c, err = policy.ParseCreate(mut, createRoute(t, hb.Name), withEnv(shared))
		wantDeny(t, c, err, deny.BindsMismatch)
	})
}

// RT1_5: the body is read strictly, and unknown fields are refused, whatever
// they are.
func TestRedTeam_RT1_5_UnknownKeys(t *testing.T) {
	top := []string{
		`"Env":["A=B"]`, `"Cmd":["sh"]`, `"Entrypoint":["sh"]`, `"User":"0"`, `"Volumes":{"/x":{}}`,
		`"ExposedPorts":{"80/tcp":{}}`, `"WorkingDir":"/"`, `"Hostname":"h"`, `"Domainname":"d"`,
		`"MacAddress":"aa:bb:cc:dd:ee:ff"`, `"StopSignal":"SIGKILL"`, `"Healthcheck":{}`,
		`"NetworkingConfig":{}`, `"AttachStdin":true`, `"Tty":true`, `"OpenStdin":true`, `"OnBuild":[]`,
		`"Shell":["sh"]`, `"StopTimeout":1`, `"ArgsEscaped":true`, `"NetworkDisabled":false`,
	}
	host := []string{
		`"Devices":[]`, `"DeviceRequests":[]`, `"CapAdd":["SYS_ADMIN"]`, `"PidMode":"host"`, `"IpcMode":"host"`,
		`"UsernsMode":"host"`, `"UTSMode":"host"`, `"CgroupParent":"/"`, `"Sysctls":{}`, `"PortBindings":{}`,
		`"Mounts":[]`, `"VolumesFrom":["x"]`, `"Links":["x"]`, `"Dns":["1.1.1.1"]`, `"ExtraHosts":["a:b"]`,
		`"Runtime":"runc"`, `"Cgroup":"x"`, `"OomKillDisable":true`, `"Ulimits":[]`, `"LogConfig":{}`,
		`"Isolation":"x"`, `"MaskedPaths":[]`, `"ReadonlyPaths":[]`, `"GroupAdd":["0"]`, `"StorageOpt":{}`,
		`"ShmSize":1`, `"AutoRemove":true`, `"PublishAllPorts":true`, `"CpusetCpus":"0"`, `"CpuShares":1`,
		`"BlkioWeight":1`, `"MemorySwap":-1`, `"OomScoreAdj":-1000`, `"Tmpfsx":{}`, `"VolumeDriver":"x"`,
		`"ConsoleSize":[1,1]`, `"Annotations":{}`, `"CgroupnsMode":"host"`, `"NetworkMode2":"x"`,
	}
	m := fixture.Load(t)
	b, body := m.FindBody(t, "bot-plain", "")
	for _, kv := range top {
		t.Run("top "+kv, func(t *testing.T) {
			mut := replace(t, body, `{"Image":`, `{`+kv+`,"Image":`)
			c, err := policy.ParseCreate(mut, createRoute(t, b.Name), env(m))
			wantDeny(t, c, err, deny.JSONUnknownKey)
		})
	}
	for _, kv := range host {
		t.Run("host "+kv, func(t *testing.T) {
			mut := replace(t, body, `"HostConfig":{`, `"HostConfig":{`+kv+`,`)
			c, err := policy.ParseCreate(mut, createRoute(t, b.Name), env(m))
			wantDeny(t, c, err, deny.JSONUnknownKey)
		})
	}
}

func TestRedTeam_RT1_5_JSONShape(t *testing.T) {
	m := fixture.Load(t)
	b, body := m.FindBody(t, "bot-plain", "")
	rt := createRoute(t, b.Name)
	s := string(body)
	cases := []struct {
		name string
		body string
		code string
	}{
		{"empty", ``, deny.JSONSyntax},
		{"bom", "\xef\xbb\xbf" + s, deny.JSONSyntax},
		{"truncated", s[:len(s)-1], deny.JSONSyntax},
		{"trailing object", s + `{}`, deny.JSONSyntax},
		{"null", `null`, deny.JSONType},
		{"array", `[]`, deny.JSONType},
		{"string", `"x"`, deny.JSONType},
		{"number", `1`, deny.JSONType},
		{"empty object", `{}`, deny.JSONValue},
		{"duplicate image", strings.Replace(s, `{"Image":`, `{"Image":"x","Image":`, 1), deny.JSONDuplicateKey},
		{"duplicate by case", strings.Replace(s, `{"Image":`, `{"image":"x","Image":`, 1), deny.JSONDuplicateKey},
		{"duplicate nested", strings.Replace(s, `"Privileged":false`, `"Privileged":false,"Privileged":false`, 1), deny.JSONDuplicateKey},
		{"null field", strings.Replace(s, `"Privileged":false`, `"Privileged":null`, 1), deny.JSONType},
		{"fractional memory", strings.Replace(s, `"Memory":1073741824`, `"Memory":1073741824.5`, 1), deny.JSONType},
		{"exponent memory", strings.Replace(s, `"Memory":1073741824`, `"Memory":1e9`, 1), deny.JSONType},
		{"huge memory", strings.Replace(s, `"Memory":1073741824`, `"Memory":9007199254740993`, 1), deny.JSONValue},
		{"memory as string", strings.Replace(s, `"Memory":1073741824`, `"Memory":"1073741824"`, 1), deny.JSONType},
		{"whitespace", strings.Replace(s, `{"Image":`, `{ "Image":`, 1), deny.JSONNotCanonical},
		{"trailing newline", s + "\n", deny.JSONNotCanonical},
		{"escaped letter", strings.Replace(s, `"Image":"ghcr`, `"Image":"\u0067hcr`, 1), deny.JSONNotCanonical},
		{"escaped slash", strings.Replace(s, `"Image":"ghcr.io/`, `"Image":"ghcr.io\/`, 1), deny.JSONNotCanonical},
		{"reordered keys", `{"Labels":` + s[strings.Index(s, `"Labels":`)+len(`"Labels":`):strings.Index(s, `,"HostConfig"`)] + `,"Image":` + s[len(`{"Image":`):strings.Index(s, `,"Labels"`)] + s[strings.Index(s, `,"HostConfig"`):], deny.JSONNotCanonical},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, err := policy.ParseCreate([]byte(tc.body), rt, env(m))
			wantDeny(t, c, err, tc.code)
		})
	}
}

// RT2_9: the resource limits are bounded by what the bot was enrolled with.
func TestRedTeam_RT2_9_ResourceCeilings(t *testing.T) {
	m := fixture.Load(t)
	b, body := m.FindBody(t, "bot-plain", "")
	rt := createRoute(t, b.Name)
	mk := func(maxMem int64, maxCPU float64, maxPids int64) *policy.Env {
		e := env(m)
		e.MaxMemoryMB, e.MaxCPUs, e.MaxPids = maxMem, maxCPU, maxPids
		return e
	}
	// bot-plain asks for 1024 MiB, 1 CPU and 512 pids.
	ok := []struct {
		name string
		env  *policy.Env
	}{
		{"exactly the ceiling", mk(1024, 1, 512)},
		{"above the ceiling", mk(4096, 8, 4096)},
	}
	for _, tc := range ok {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := policy.ParseCreate(body, rt, tc.env); err != nil {
				t.Fatalf("denied: %s", err.Code)
			}
		})
	}
	over := []struct {
		name string
		env  *policy.Env
	}{
		{"memory one MiB over", mk(1023, 1, 512)},
		{"cpus over", mk(1024, 0.99, 512)},
		{"cpus a tenth over", mk(1024, 0.9, 512)},
		{"pids one over", mk(1024, 1, 511)},
		{"all zero", mk(0, 0, 0)},
	}
	for _, tc := range over {
		t.Run(tc.name, func(t *testing.T) {
			c, err := policy.ParseCreate(body, rt, tc.env)
			wantDeny(t, c, err, deny.LimitExceedsEnrolled)
		})
	}
	mut := []mutation{
		{"memory zero", `"Memory":1073741824`, `"Memory":0`, false, deny.JSONValue},
		{"memory negative", `"Memory":1073741824`, `"Memory":-1`, false, deny.JSONValue},
		{"nano cpus zero", `"NanoCpus":1000000000`, `"NanoCpus":0`, false, deny.JSONValue},
		{"pids unlimited", `"PidsLimit":512`, `"PidsLimit":-1`, false, deny.JSONValue},
		{"pids zero", `"PidsLimit":512`, `"PidsLimit":0`, false, deny.JSONValue},
		{"memory over by a byte", `"Memory":1073741824`, `"Memory":1073741825`, false, deny.LimitExceedsEnrolled},
		{"nano cpus over by one", `"NanoCpus":1000000000`, `"NanoCpus":1000000001`, false, deny.LimitExceedsEnrolled},
		{"pids over by one", `"PidsLimit":512`, `"PidsLimit":513`, false, deny.LimitExceedsEnrolled},
	}
	for _, tc := range mut {
		t.Run(tc.name, func(t *testing.T) {
			e := mk(1024, 1, 512)
			c, err := policy.ParseCreate(replace(t, body, tc.old, tc.new), rt, e)
			wantDeny(t, c, err, tc.code)
		})
	}
}

// The fractional values of the driver (Math.round of the product) are within
// the ceiling of the rounded configuration.
func TestFractionalLimitsFitTheirCeiling(t *testing.T) {
	m := fixture.Load(t)
	b, body := m.FindBody(t, "bot-fractional-both", "")
	e := env(m)
	e.MaxMemoryMB, e.MaxCPUs, e.MaxPids = 1537, 2.3, 1024
	if _, err := policy.ParseCreate(body, createRoute(t, b.Name), e); err != nil {
		t.Fatalf("denied: %s (%s)", err.Code, err.Field)
	}
	e.MaxCPUs = 2.2
	c, err := policy.ParseCreate(body, createRoute(t, b.Name), e)
	wantDeny(t, c, err, deny.LimitExceedsEnrolled)
}

// The name and the labels agree: a body for the other bot is refused whatever
// its content is.
func TestNameLabelBinding(t *testing.T) {
	m := fixture.Load(t)
	for _, tc := range []struct{ id, suffix string }{
		{"bot-plain", ""}, {"bot-plain", ".next"}, {"helper-prepare", ".helper"}, {"helper-apply-0123456789abcdef", ".helper"},
	} {
		b, body := m.FindBody(t, tc.id, tc.suffix)
		name := "myrmidon-bot-" + otherKey + tc.suffix
		c, err := policy.ParseCreate(body, createRoute(t, name), env(m))
		wantDeny(t, c, err, deny.NameLabelMismatch)
		_ = b
	}
}

func TestHelperBodyMutations(t *testing.T) {
	m := fixture.Load(t)
	k, root := m.BotKey, m.VolumeRoot
	hermes := root + "/" + k + "/hermes:/data/hermes"
	otherImg := strings.Replace(m.Image, "0123456789abcdef0123456789abcdef", "ffffffffffffffffffffffffffffffff", 1)
	runMutations(t, "helper-prepare", ".helper", []mutation{
		{"image not in the list", `"Image":"` + m.Image + `"`, `"Image":"` + otherImg + `"`, false, deny.ImageNotAllowed},
		{"image by tag", `"Image":"` + m.Image + `"`, `"Image":"busybox:latest"`, false, deny.ImageNotAllowed},
		{"user 1000", `"User":"0:0"`, `"User":"1000:1000"`, false, deny.JSONValue},
		{"user root by name", `"User":"0:0"`, `"User":"root"`, false, deny.JSONValue},
		{"user 0 alone", `"User":"0:0"`, `"User":"0"`, false, deny.JSONValue},
		{"user 0 and bot group", `"User":"0:0"`, `"User":"0:10001"`, false, deny.JSONValue},
		{"empty user", `"User":"0:0"`, `"User":""`, false, deny.JSONValue},
		{"user as number", `"User":"0:0"`, `"User":0`, false, deny.JSONType},
		{"script: recursive chown", `chown 10001:10001`, `chown -R 10001:10001`, false, deny.ScriptMismatch},
		{"script: chmod 777", `chmod 0700`, `chmod 0777`, false, deny.ScriptMismatch},
		{"script: another target", `data/hermes workspace scratch`, `data/hermes workspace scratch /`, false, deny.ScriptMismatch},
		{"script: no -u", `set -eu`, `set -e`, false, deny.ScriptMismatch},
		{"script: appended command", `done"`, `done; id"`, false, deny.ScriptMismatch},
		{"script: empty", `"set -eu\ncd \"$1\"\nfor d in data/hermes workspace scratch; do\n  chmod 0700 \"$d\"\n  chown 10001:10001 \"$d\"\ndone"`, `""`, false, deny.ScriptMismatch},
		{"entrypoint changed", `"Entrypoint":["/bin/sh","-c"]`, `"Entrypoint":["/bin/sh"]`, false, deny.JSONValue},
		{"entrypoint bash", `"Entrypoint":["/bin/sh","-c"]`, `"Entrypoint":["/bin/bash","-c"]`, false, deny.JSONValue},
		{"cmd argument 1", `"myrmidon-helper"`, `"other"`, false, deny.JSONValue},
		{"cmd argument 2", `"myrmidon-helper","/"]`, `"myrmidon-helper","/etc"]`, false, deny.JSONValue},
		{"cmd with an extra argument", `"myrmidon-helper","/"]`, `"myrmidon-helper","/","x"]`, false, deny.JSONValue},
		{"cmd without arguments", `,"myrmidon-helper","/"]`, `]`, false, deny.JSONValue},
		{"label of another bot", `"myrmidon.bot-helper":"` + k + `"`, `"myrmidon.bot-helper":"` + otherKey + `"`, false, deny.NameLabelMismatch},
		{"label renamed", `"myrmidon.bot-helper"`, `"myrmidon.bot"`, false, deny.JSONUnknownKey},
		{"network enabled", `"NetworkDisabled":true`, `"NetworkDisabled":false`, false, deny.JSONValue},
		{"host network", `"NetworkMode":"none"`, `"NetworkMode":"host"`, false, deny.JSONValue},
		{"bot network", `"NetworkMode":"none"`, `"NetworkMode":"` + m.Network + `"`, false, deny.JSONValue},
		{"memory", `"Memory":134217728`, `"Memory":268435456`, false, deny.JSONValue},
		{"pids", `"PidsLimit":64`, `"PidsLimit":65`, false, deny.JSONValue},
		{"cap add sys_admin", `"CapAdd":["CHOWN","FOWNER"]`, `"CapAdd":["CHOWN","FOWNER","SYS_ADMIN"]`, false, deny.JSONValue},
		{"cap add dac override", `"CapAdd":["CHOWN","FOWNER"]`, `"CapAdd":["CHOWN","FOWNER","DAC_OVERRIDE"]`, false, deny.JSONValue},
		{"cap add empty", `"CapAdd":["CHOWN","FOWNER"]`, `"CapAdd":[]`, false, deny.JSONValue},
		{"cap add reordered", `"CapAdd":["CHOWN","FOWNER"]`, `"CapAdd":["FOWNER","CHOWN"]`, false, deny.JSONValue},
		{"cap drop", `"CapDrop":["ALL"]`, `"CapDrop":[]`, false, deny.JSONValue},
		{"privileged", `"Privileged":false`, `"Privileged":true`, false, deny.JSONValue},
		{"writable rootfs", `"ReadonlyRootfs":true`, `"ReadonlyRootfs":false`, false, deny.JSONValue},
		{"restart policy", `"RestartPolicy":{"Name":"no"}`, `"RestartPolicy":{"Name":"always"}`, false, deny.JSONValue},
		{"security opt", `"SecurityOpt":["no-new-privileges"]`, `"SecurityOpt":[]`, false, deny.JSONValue},
		{"host root bind", `"` + hermes + `"`, `"/:/data/hermes"`, false, deny.BindsMismatch},
		{"docker socket bind", `"` + hermes + `"`, `"/var/run/docker.sock:/data/hermes"`, false, deny.BindsMismatch},
		{"another bot bind", `"` + hermes + `"`, `"` + root + "/" + otherKey + `/hermes:/data/hermes"`, false, deny.BindsMismatch},
		{"extra key", `"NetworkDisabled":true,`, `"NetworkDisabled":true,"Tty":true,`, false, deny.JSONUnknownKey},
		{"extra host key", `"HostConfig":{`, `"HostConfig":{"Devices":[],`, false, deny.JSONUnknownKey},
		{"tmpfs on the helper", `"HostConfig":{`, `"HostConfig":{"Tmpfs":{"/tmp":""},`, false, deny.JSONUnknownKey},
	})
}

func TestApplyHelperMutations(t *testing.T) {
	m := fixture.Load(t)
	n := "0123456789abcdef"
	runMutations(t, "helper-apply-"+n, ".helper", []mutation{
		{"image by reference", `"Image":"` + m.ImageID + `"`, `"Image":"` + m.Image + `"`, false, deny.ImageNotAllowed},
		{"image by tag", `"Image":"` + m.ImageID + `"`, `"Image":"busybox:latest"`, false, deny.ImageNotAllowed},
		{"image id uppercase", `"Image":"` + m.ImageID + `"`, `"Image":"sha256:` + strings.ToUpper(m.ImageID[7:]) + `"`, false, deny.ImageNotAllowed},
		{"image id short", `"Image":"` + m.ImageID + `"`, `"Image":"` + m.ImageID[:len(m.ImageID)-1] + `"`, false, deny.ImageNotAllowed},
		{"image id without prefix", `"Image":"` + m.ImageID + `"`, `"Image":"` + m.ImageID[7:] + `"`, false, deny.ImageNotAllowed},
		{"cap add", `"CapAdd":[]`, `"CapAdd":["CHOWN","FOWNER"]`, false, deny.JSONValue},
		{"cap add one", `"CapAdd":[]`, `"CapAdd":["CHOWN"]`, false, deny.JSONValue},
		{"nonce with a letter", `n=` + n, `n=0123456789abcdeg`, false, deny.NonceInvalid},
		{"nonce uppercase", `n=` + n, `n=0123456789ABCDEF`, false, deny.NonceInvalid},
		{"nonce short", `n=` + n, `n=0123456789abcde`, false, deny.NonceInvalid},
		{"nonce long", `n=` + n, `n=0123456789abcdef0`, false, deny.NonceInvalid},
		{"nonce empty", `n=` + n, `n=`, false, deny.NonceInvalid},
		{"nonce with a command", `n=` + n, `n=0123456789abcdef;id`, false, deny.NonceInvalid},
		{"another nonce in the list path", `.myrmidon-apply-` + n + `/staged.list`, `.myrmidon-apply-fedcba9876543210/staged.list`, false, deny.ScriptMismatch},
		{"no nonce line", `\nn=` + n + `\n`, `\nm=` + n + `\n`, false, deny.ScriptMismatch},
		{"script line removed", `# 1. staging from interrupted earlier applies\n`, ``, false, deny.ScriptMismatch},
		{"script line added", `umask 077\n`, `umask 077\nid\n`, false, deny.ScriptMismatch},
		{"marker moved", `mv -f -T -- \"data/hermes/.myrmidon-apply-` + n + `/applied.json\"`, `mv -f -T -- \"data/hermes/.myrmidon-apply-` + n + `/applied.jsoo\"`, false, deny.ScriptMismatch},
		{"script with a prefix", `"Cmd":["`, `"Cmd":["x`, false, deny.ScriptMismatch},
	})
}

// The root helper runs only the prepare script; the apply script is refused
// under the root user, and the prepare script under the bot user.
func TestScriptUserPairing(t *testing.T) {
	m := fixture.Load(t)
	ab, apply := m.FindBody(t, "helper-apply-0123456789abcdef", ".helper")
	root := replace(t, replace(t, apply, `"User":"10001:10001"`, `"User":"0:0"`), `"Image":"`+m.ImageID+`"`, `"Image":"`+m.Image+`"`)
	c, err := policy.ParseCreate(root, createRoute(t, ab.Name), env(m))
	wantDeny(t, c, err, deny.ScriptMismatch)

	pb, prep := m.FindBody(t, "helper-prepare", ".helper")
	bot := replace(t, replace(t, prep, `"User":"0:0"`, `"User":"10001:10001"`), `"Image":"`+m.Image+`"`, `"Image":"`+m.ImageID+`"`)
	c, err = policy.ParseCreate(bot, createRoute(t, pb.Name), env(m))
	if err == nil {
		t.Fatalf("the prepare script accepted under the bot user (form %v)", c.Form)
	}
	if err.Code != deny.ScriptMismatch && err.Code != deny.NonceInvalid {
		t.Fatalf("denied as %s", err.Code)
	}
}

func TestQuoteMatchesJSONStringify(t *testing.T) {
	cases := map[string]string{
		"plain":       `"plain"`,
		`a"b`:         `"a\"b"`,
		`a\b`:         `"a\\b"`,
		"a\nb\rc\td":  `"a\nb\rc\td"`,
		"\b\f":        `"\b\f"`,
		"\x01\x1f":    `"\u0001\u001f"`,
		"a/b":         `"a/b"`,
		"<>&":         `"<>&"`,
		"  ":          "\"  \"",
		"\x7f":        "\"\x7f\"",
		"é":           `"é"`,
		"\U0001F600":  "\"\U0001F600\"",
		"$1 `x` $(y)": "\"$1 `x` $(y)\"",
	}
	for in, want := range cases {
		if got := policy.Quote(in); got != want {
			t.Errorf("Quote(%q) = %s, want %s", in, got, want)
		}
	}
}
