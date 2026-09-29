package gate_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fakedocker"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fixture"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/gate"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/peer"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
)

// The rig: a real gate on a real unix socket, in front of the fake daemon.
// Only what the kernel would tell (the peer credentials) and what the host
// would tell (lstat of the volume root, /proc) is replaced.

// Canaries that must never leave the gate: the fake daemon puts them into the
// inspect answers, the tests put them into requests.
const (
	envCanary  = "SECRET_TOKEN=canary-env-secret"
	bindCanary = "/host/canary-bind:/x"
)

// syncBuf is the log sink.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// Lines decodes every line of the log into gate.Line. An unknown key in a line
// is a failure: a line has fixed fields and nothing else.
func (s *syncBuf) Lines(t testing.TB) []gate.Line {
	t.Helper()
	var out []gate.Line
	for _, raw := range strings.Split(s.String(), "\n") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		dec := json.NewDecoder(strings.NewReader(raw))
		dec.DisallowUnknownFields()
		var l gate.Line
		if err := dec.Decode(&l); err != nil {
			t.Fatalf("log line %q: %v", raw, err)
		}
		out = append(out, l)
	}
	return out
}

// --- fake /proc (container mode) -----------------------------------------------

type fproc struct {
	comm  string
	ppid  int
	start uint64
	uid   uint32
	gid   uint32
	argv  []string
	leaf  string
}

type fakeProc struct {
	mu    sync.Mutex
	procs map[int]fproc
}

var boardID = strings.Repeat("ab", 32)

const (
	tiniPID = 100
	nodePID = 101
)

func newFakeProc() *fakeProc {
	leaf := "docker-" + boardID + ".scope"
	return &fakeProc{procs: map[int]fproc{
		tiniPID: {comm: "tini", ppid: 1, start: 1000, uid: 0, gid: 0, leaf: leaf},
		nodePID: {comm: "node", ppid: tiniPID, start: 1010, uid: 1000, gid: 1000, argv: []string{"node", "server.js"}, leaf: leaf},
	}}
}

func (f *fakeProc) get(pid int) (fproc, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.procs[pid]
	if !ok {
		return fproc{}, errors.New("no such process")
	}
	return p, nil
}

func (f *fakeProc) add(pid int, p fproc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.procs[pid] = p
}

func (f *fakeProc) remove(pid int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.procs, pid)
}

func (f *fakeProc) Pids() ([]int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]int, 0, len(f.procs))
	for pid := range f.procs {
		out = append(out, pid)
	}
	return out, nil
}

func (f *fakeProc) Stat(pid int) (peer.Stat, error) {
	p, err := f.get(pid)
	if err != nil {
		return peer.Stat{}, err
	}
	return peer.Stat{Comm: p.comm, PPid: p.ppid, StartTime: p.start}, nil
}

func (f *fakeProc) Status(pid int) (peer.Status, error) {
	p, err := f.get(pid)
	if err != nil {
		return peer.Status{}, err
	}
	return peer.Status{
		UIDs: [4]uint32{p.uid, p.uid, p.uid, p.uid},
		GIDs: [4]uint32{p.gid, p.gid, p.gid, p.gid},
	}, nil
}

func (f *fakeProc) Cmdline(pid int) ([]string, error) {
	p, err := f.get(pid)
	if err != nil {
		return nil, err
	}
	return p.argv, nil
}

func (f *fakeProc) CgroupLeaf(pid int) (string, error) {
	p, err := f.get(pid)
	if err != nil {
		return "", err
	}
	return p.leaf, nil
}

// --- the rig ---------------------------------------------------------------------

type rigOptions struct {
	cfg       []func(*config.Config)
	container bool
	noServe   bool
	log       io.Writer
}

type rigOpt func(*rigOptions)

func withConfig(f func(*config.Config)) rigOpt {
	return func(o *rigOptions) { o.cfg = append(o.cfg, f) }
}

// withContainerCaller makes the caller the main process of the board container
// (the production mode), against a fake /proc.
func withContainerCaller() rigOpt { return func(o *rigOptions) { o.container = true } }

// withoutServe builds the gate and the daemon but does not listen.
func withoutServe() rigOpt { return func(o *rigOptions) { o.noServe = true } }

type fsEntry struct {
	fi  policy.FileInfo
	err error
}

type rig struct {
	t    *testing.T
	dir  string
	d    *fakedocker.Daemon
	g    *gate.Gate
	m    *fixture.Manifest
	cfg  *config.Config
	log  *syncBuf
	sock string
	proc *fakeProc

	mu    sync.Mutex
	cred  peer.Cred
	files map[string]fsEntry
}

func (r *rig) credFn(net.Conn) (peer.Cred, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cred, nil
}

func (r *rig) setCred(pid int, uid, gid uint32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cred = peer.Cred{PID: pid, UID: uid, GID: gid}
}

func (r *rig) lstat(p string) (policy.FileInfo, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.files[p]; ok {
		return e.fi, e.err
	}
	if p == r.cfg.VolumeRoot {
		return policy.FileInfo{Dir: true, UID: 0, Perm: 0o755}, nil
	}
	return policy.FileInfo{}, &fs.PathError{Op: "lstat", Path: p, Err: fs.ErrNotExist}
}

// setFS makes lstat of path answer fi (or err).
func (r *rig) setFS(path string, fi policy.FileInfo, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.files[path] = fsEntry{fi: fi, err: err}
}

func newRig(t *testing.T, opts ...rigOpt) *rig {
	t.Helper()
	var o rigOptions
	for _, f := range opts {
		f(&o)
	}
	dir, err := os.MkdirTemp("", "dg")
	if err != nil {
		t.Fatal(err)
	}
	d, err := fakedocker.New(dir)
	if err != nil {
		os.RemoveAll(dir)
		t.Fatal(err)
	}
	m := fixture.Load(t)

	lim := config.DefaultLimits()
	// The default rig is not about the limits: they are raised so that a long
	// table of requests does not run into them. The tests of the limits set
	// their own.
	lim.GlobalRate, lim.GlobalBurst = 10000, 10000
	lim.InspectRate, lim.InspectBurst = 10000, 10000
	lim.CreatePerWindow, lim.StartPerWindow, lim.RestartPerWindow = 1000, 1000, 1000
	lim.StopPerWindow, lim.PutPerWindow = 1000, 1000
	cfg := &config.Config{
		Listen:     filepath.Join(dir, "gate.sock"),
		Upstream:   d.Socket,
		APIVersion: config.SupportedAPIVersion,
		Caller:     &config.Caller{UID: 1000, GID: 1000, MaxStartDelayTicks: 500, Mode: config.ModeUID},
		VolumeRoot: m.VolumeRoot,
		Network:    m.Network,
		Images:     []string{m.Image},
		Bots:       []config.Bot{{BotKey: m.BotKey, MaxMemoryMB: 2048, MaxCPUs: 4, MaxPids: 2048}},
		Limits:     lim,
		StatsFile:  filepath.Join(dir, "stats.json"),
	}
	r := &rig{
		t: t, dir: dir, d: d, m: m, cfg: cfg, log: &syncBuf{}, sock: cfg.Listen,
		cred:  peer.Cred{PID: 4242, UID: 1000, GID: 1000},
		files: map[string]fsEntry{},
	}
	if o.container {
		r.proc = newFakeProc()
		cfg.Caller = &config.Caller{
			Container:          "board",
			ContainerLabels:    map[string]string{"role": "board"},
			UID:                1000,
			GID:                1000,
			Argv:               []string{"node", "server.js"},
			MaxStartDelayTicks: 500,
			Mode:               config.ModeContainerMainProcess,
		}
		r.cred = peer.Cred{PID: nodePID, UID: 1000, GID: 1000}
		d.Seed(fakedocker.Container{
			ID: boardID, Name: "board", Labels: map[string]string{"role": "board"},
			Status: "running", Pid: tiniPID,
		})
	}
	for _, f := range o.cfg {
		f(cfg)
	}
	d.AddImage(fakedocker.Image{
		Ref: m.Image, ID: m.ImageID, User: policy.BotUser,
		Labels: map[string]string{policy.RuntimeContractLabel: "1"},
		Env:    []string{"PATH=/usr/local/bin:/usr/bin:/bin", envCanary},
	})

	gopt := gate.Options{
		Cfg: cfg, ConfigHash: "test", Version: "test", Log: r.log,
		Cred: r.credFn, Lstat: r.lstat,
	}
	if r.proc != nil {
		gopt.Proc = r.proc
	}
	g, err := gate.New(gopt)
	if err != nil {
		d.Close()
		os.RemoveAll(dir)
		t.Fatal(err)
	}
	r.g = g

	var (
		cancel context.CancelFunc = func() {}
		done   chan error
	)
	if r.proc != nil {
		if err := g.Auth().Resolve(context.Background()); err != nil || g.Auth().Pinned() == nil {
			d.Close()
			os.RemoveAll(dir)
			t.Fatalf("the board was not pinned: %v", err)
		}
	}
	if !o.noServe {
		ln, err := g.Listen()
		if err != nil {
			d.Close()
			os.RemoveAll(dir)
			t.Fatal(err)
		}
		var ctx context.Context
		ctx, cancel = context.WithCancel(context.Background())
		done = make(chan error, 1)
		go func() { done <- g.Serve(ctx, ln) }()
	}
	t.Cleanup(func() {
		cancel()
		if done != nil {
			select {
			case <-done:
			case <-time.After(15 * time.Second):
				t.Error("Serve did not return")
			}
		}
		g.Close()
		d.Close()
		os.RemoveAll(dir)
		// The log of every test of the package is checked for the planted
		// strings (spec 12.1, "the log without secrets"): the Env, the binds and
		// the health output that the fake daemon puts into its answers, and
		// whatever a test plants into a request has "canary" in it.
		logged := r.log.String()
		for _, c := range []string{"canary", "secret"} {
			if strings.Contains(logged, c) {
				t.Errorf("the log carries %q:\n%s", c, logged)
			}
		}
	})
	return r
}

// --- names and seeds ---------------------------------------------------------------

func (r *rig) key() string { return r.m.BotKey }

func (r *rig) name(sfx string) string { return "myrmidon-bot-" + r.m.BotKey + sfx }

func (r *rig) target(sfx, tail string) string { return "/v1.45/containers/" + r.name(sfx) + tail }

// id is the Id that the daemon gave the container with the name.
func (r *rig) id(sfx string) string {
	c, ok := r.d.Get(r.name(sfx))
	if !ok {
		r.t.Fatalf("no container %s", r.name(sfx))
	}
	return c.ID
}

func (r *rig) seedMain(status string) {
	r.t.Helper()
	r.d.Seed(fakedocker.Container{
		Name:     r.name(""),
		ImageID:  r.m.ImageID,
		ImageRef: r.m.Image,
		Labels:   map[string]string{"myrmidon.bot": r.key(), "myrmidon.image": r.m.Image},
		User:     policy.BotUser,
		Env:      []string{envCanary},
		Binds:    []string{bindCanary},
		Status:   status, Health: "healthy",
		Memory: 1 << 30, NanoCPUs: 1_000_000_000, PidsLimit: 512, NetworkMode: r.m.Network,
	})
}

func (r *rig) seedNext(status string) {
	r.t.Helper()
	r.d.Seed(fakedocker.Container{
		Name:     r.name(".next"),
		ImageID:  r.m.ImageID,
		ImageRef: r.m.Image,
		Labels:   map[string]string{"myrmidon.bot": r.key()},
		User:     policy.BotUser,
		Status:   status,
		Memory:   1 << 30, NanoCPUs: 1_000_000_000, PidsLimit: 512, NetworkMode: r.m.Network,
	})
}

// seedApplyHelper is an apply helper as the create of the board makes it: the
// reference script of the nonce, the bot user, the label of the role.
func (r *rig) seedApplyHelper(nonce, status string) {
	r.t.Helper()
	r.d.Seed(fakedocker.Container{
		Name:    r.name(".helper"),
		ImageID: r.m.ImageID, ImageRef: r.m.ImageID,
		Labels: map[string]string{"myrmidon.bot-helper": r.key()},
		User:   policy.BotUser,
		Cmd:    []string{policy.ApplyScript(nonce), "myrmidon-helper", "/"},
		Status: status,
	})
}

// seedPrepareHelper is a helper of the root role.
func (r *rig) seedPrepareHelper(status string) {
	r.t.Helper()
	r.d.Seed(fakedocker.Container{
		Name:    r.name(".helper"),
		ImageID: r.m.ImageID, ImageRef: r.m.Image,
		Labels: map[string]string{"myrmidon.bot-helper": r.key()},
		User:   "0:0",
		Cmd:    []string{policy.PrepareScript, "myrmidon-helper", "/"},
		Status: status,
	})
}

// --- the client ----------------------------------------------------------------------

type resp struct {
	Status int
	Header http.Header
	Body   []byte
	Close  bool
}

// str is the body as a string.
func (r *resp) str() string { return string(r.Body) }

type client struct {
	t  testing.TB
	c  net.Conn
	br *bufio.Reader
}

func (r *rig) dial() *client {
	r.t.Helper()
	c, err := net.DialTimeout("unix", r.sock, 5*time.Second)
	if err != nil {
		r.t.Fatalf("dial: %v", err)
	}
	return &client{t: r.t, c: c, br: bufio.NewReader(c)}
}

func (c *client) close() { _ = c.c.Close() }

// write sends bytes without waiting for anything. It runs on its own goroutine
// and ignores the error: a gate that refuses early closes the connection with
// part of the request unsent, and that is not a failure of the test client.
func (c *client) write(b []byte) {
	go func() { _, _ = c.c.Write(b) }()
}

// read reads one response.
func (c *client) read(method string) *resp {
	c.t.Helper()
	_ = c.c.SetReadDeadline(time.Now().Add(10 * time.Second))
	res, err := http.ReadResponse(c.br, &http.Request{Method: method})
	if err != nil {
		c.t.Fatalf("read response: %v", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		c.t.Fatalf("read response body: %v", err)
	}
	return &resp{Status: res.StatusCode, Header: res.Header, Body: body, Close: res.Close}
}

func hasHeader(hdr map[string]string, name string) bool {
	for k := range hdr {
		if strings.EqualFold(k, name) {
			return true
		}
	}
	return false
}

// buildRaw writes a request. Host and Content-Length are added unless given.
func buildRaw(method, target string, hdr map[string]string, body []byte) []byte {
	var b bytes.Buffer
	b.WriteString(method + " " + target + " HTTP/1.1\r\n")
	if !hasHeader(hdr, "Host") {
		b.WriteString("Host: localhost\r\n")
	}
	for k, v := range hdr {
		b.WriteString(k + ": " + v + "\r\n")
	}
	if !hasHeader(hdr, "Content-Length") && !hasHeader(hdr, "Transfer-Encoding") &&
		(body != nil || method == "POST" || method == "PUT") {
		b.WriteString("Content-Length: " + strconv.Itoa(len(body)) + "\r\n")
	}
	b.WriteString("\r\n")
	b.Write(body)
	return b.Bytes()
}

// do sends a request on the connection and reads the answer.
func (c *client) do(method, target string, hdr map[string]string, body []byte) *resp {
	c.t.Helper()
	c.write(buildRaw(method, target, hdr, body))
	return c.read(method)
}

// send is one request on a connection of its own.
func (r *rig) send(method, target string, hdr map[string]string, body []byte) *resp {
	r.t.Helper()
	c := r.dial()
	defer c.close()
	return c.do(method, target, hdr, body)
}

// raw sends bytes as they are and reads one answer.
func (r *rig) raw(b []byte, method string) *resp {
	r.t.Helper()
	c := r.dial()
	defer c.close()
	c.write(b)
	return c.read(method)
}

var (
	jsonHdr = map[string]string{"Content-Type": "application/json"}
	tarHdr  = map[string]string{"Content-Type": "application/x-tar"}
)

// --- assertions ------------------------------------------------------------------------

var denyRe = regexp.MustCompile(`dockergate: denied \(([a-z_]+)\)`)

// denyCode is the reason code in the body of a denial, "" when it is not one.
func denyCode(res *resp) string {
	m := denyRe.FindStringSubmatch(res.str())
	if m == nil {
		return ""
	}
	return m[1]
}

// wantDeny checks the answer of a denial: the status of the code, and the
// body and the type that dockergate itself writes.
func wantDeny(t testing.TB, res *resp, code string) {
	t.Helper()
	wantDenyStatus(t, res, deny.StatusFor(code), code)
}

func wantDenyStatus(t testing.TB, res *resp, status int, code string) {
	t.Helper()
	if res.Status != status {
		t.Errorf("status %d, want %d (%s); body %q", res.Status, status, code, res.str())
	}
	if got := denyCode(res); got != code {
		t.Errorf("reason %q, want %q; body %q", got, code, res.str())
	}
	if want := deny.Message(code); res.str() != want {
		t.Errorf("body %q, want %q", res.str(), want)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q, want application/json", ct)
	}
}

// --- the calls that the daemon saw ---------------------------------------------------------

const boardInspectURI = "/v1.45/containers/board/json"

// calls are the daemon's calls made for the tests: not the ping of the
// heartbeat, not the version of the self-check, not the inspect of the board.
func (r *rig) calls() []fakedocker.Call {
	var out []fakedocker.Call
	for _, c := range r.d.APICalls() {
		if c.Method == "GET" && c.URI == boardInspectURI {
			continue
		}
		out = append(out, c)
	}
	return out
}

// uris are the calls as "METHOD URI".
func (r *rig) uris() []string {
	var out []string
	for _, c := range r.calls() {
		out = append(out, c.Method+" "+c.URI)
	}
	return out
}

func (r *rig) wantNoCalls() {
	r.t.Helper()
	if got := r.uris(); len(got) != 0 {
		r.t.Errorf("the daemon was called: %v", got)
	}
}

// count is the number of calls with the method whose URI has the prefix.
func (r *rig) count(method, prefix string) int {
	n := 0
	for _, c := range r.calls() {
		if c.Method == method && strings.HasPrefix(c.URI, prefix) {
			n++
		}
	}
	return n
}

func (r *rig) created() int { return r.count("POST", "/v1.45/containers/create") }

// --- the log ---------------------------------------------------------------------------------

// decisions are the log lines of requests.
func (r *rig) decisions() []gate.Line {
	var out []gate.Line
	for _, l := range r.log.Lines(r.t) {
		if l.Decision != "" {
			out = append(out, l)
		}
	}
	return out
}

// eventually polls f until it holds or three seconds pass.
func eventually(t testing.TB, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout: %s", what)
}

// lastDecision waits for a decision line and returns the last one.
func (r *rig) lastDecision() gate.Line {
	r.t.Helper()
	eventually(r.t, "a decision line", func() bool { return len(r.decisions()) > 0 })
	ds := r.decisions()
	return ds[len(ds)-1]
}
