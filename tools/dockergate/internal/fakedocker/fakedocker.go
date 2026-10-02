// Package fakedocker is a stateful stand-in for the Docker daemon, for the
// tests of the gate and of the contract. It speaks the small part of the API
// that dockergate and the driver use, keeps containers by Id and by name,
// records every call as it arrived (the raw request-target, the headers, the
// body), and lets a test replace the answer of any call. The package is
// imported by test files only and is not part of the binary.
package fakedocker

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Call is one request as the daemon received it.
type Call struct {
	Method string
	// URI is the request-target exactly as it was written on the wire.
	URI    string
	Host   string
	Header http.Header
	Body   []byte
	// ContentLength is -1 when the length was not declared.
	ContentLength int64
	Chunked       bool
}

// Path is the part of the request-target before the query.
func (c Call) Path() string {
	p, _, _ := strings.Cut(c.URI, "?")
	return p
}

// Reply replaces the answer of a call.
type Reply struct {
	Status int
	Header map[string]string
	Body   []byte
	// Delay is waited before the answer; it ends when the client goes away.
	Delay time.Duration
	// Hang blocks until the client goes away.
	Hang bool
	// Upgrade answers "101 Switching Protocols" on the raw connection.
	Upgrade bool
	// OnCancel is called when the client goes away during Delay or Hang.
	OnCancel func()
}

// Image is an image that the daemon knows.
type Image struct {
	Ref    string
	ID     string
	User   string
	Labels map[string]string
	Env    []string
}

// Upload is one PUT of a tar into a container.
type Upload struct {
	Path string
	Body []byte
}

// Container is a container of the daemon.
type Container struct {
	ID       string
	Name     string
	ImageID  string
	ImageRef string
	Labels   map[string]string
	User     string
	Cmd      []string
	Env      []string
	Status   string
	ExitCode int
	Pid      int
	Health   string

	Memory      int64
	NanoCPUs    int64
	PidsLimit   int64
	NetworkMode string
	Binds       []string

	// Create is the body of the create call, as it arrived.
	Create  []byte
	Uploads []Upload
	// Marker is the tar that the archive GET of the applied marker returns;
	// nil is "no such file".
	Marker []byte
	// Logs is the text of the log stream.
	Logs []byte
}

// Daemon is the fake.
type Daemon struct {
	Socket string

	mu     sync.Mutex
	ln     net.Listener
	srv    *http.Server
	calls  []Call
	hook   func(Call) *Reply
	images map[string]*Image
	byID   map[string]*Container
	byName map[string]string
	seq    int
	api    string
	minAPI string
}

// New starts a daemon on a unix socket in dir.
func New(dir string) (*Daemon, error) {
	sock := filepath.Join(dir, "docker.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		return nil, err
	}
	d := &Daemon{
		Socket: sock, ln: ln,
		images: map[string]*Image{},
		byID:   map[string]*Container{},
		byName: map[string]string{},
		api:    "1.45", minAPI: "1.24",
	}
	d.srv = &http.Server{Handler: d}
	go func() { _ = d.srv.Serve(ln) }()
	return d, nil
}

// Close stops the daemon.
func (d *Daemon) Close() {
	_ = d.srv.Close()
	_ = os.Remove(d.Socket)
}

// SetAPI sets the versions that GET /version reports.
func (d *Daemon) SetAPI(api, min string) {
	d.mu.Lock()
	d.api, d.minAPI = api, min
	d.mu.Unlock()
}

// SetHook installs a function that may replace the answer of a call.
func (d *Daemon) SetHook(f func(Call) *Reply) {
	d.mu.Lock()
	d.hook = f
	d.mu.Unlock()
}

// AddImage makes an image known.
func (d *Daemon) AddImage(im Image) {
	d.mu.Lock()
	c := im
	d.images[im.Ref] = &c
	d.mu.Unlock()
}

// RemoveImage forgets an image.
func (d *Daemon) RemoveImage(ref string) {
	d.mu.Lock()
	delete(d.images, ref)
	d.mu.Unlock()
}

// Seed adds a container that was there before the test began. An empty ID
// gets a generated one.
func (d *Daemon) Seed(c Container) *Container {
	d.mu.Lock()
	defer d.mu.Unlock()
	if c.ID == "" {
		c.ID = d.newID(c.Name)
	}
	if c.Status == "" {
		c.Status = "created"
	}
	cp := c
	d.byID[cp.ID] = &cp
	d.byName[cp.Name] = cp.ID
	return &cp
}

// Modify changes a container in place under the lock of the daemon.
func (d *Daemon) Modify(name string, f func(*Container)) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	c := d.find(name)
	if c == nil {
		return false
	}
	f(c)
	return true
}

// Get returns a copy of the container with the name (or Id).
func (d *Daemon) Get(name string) (Container, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	c := d.find(name)
	if c == nil {
		return Container{}, false
	}
	return *c, true
}

// Names lists the container names, unsorted.
func (d *Daemon) Names() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, 0, len(d.byName))
	for n := range d.byName {
		out = append(out, n)
	}
	return out
}

// Calls returns every call so far.
func (d *Daemon) Calls() []Call {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]Call(nil), d.calls...)
}

// APICalls returns the calls that are not the housekeeping of dockergate
// itself (the ping of the heartbeat and the version of the self-check).
func (d *Daemon) APICalls() []Call {
	var out []Call
	for _, c := range d.Calls() {
		if p := c.Path(); p == "/_ping" || p == "/version" {
			continue
		}
		out = append(out, c)
	}
	return out
}

// Reset forgets the recorded calls.
func (d *Daemon) Reset() {
	d.mu.Lock()
	d.calls = nil
	d.mu.Unlock()
}

func (d *Daemon) newID(name string) string {
	d.seq++
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s#%d", name, d.seq)))
	return hex.EncodeToString(sum[:])
}

func isHexID(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// find looks a container up by Id first, then by name. The caller holds mu.
func (d *Daemon) find(ref string) *Container {
	if c, ok := d.byID[ref]; ok {
		return c
	}
	if id, ok := d.byName[ref]; ok {
		return d.byID[id]
	}
	return nil
}

func (d *Daemon) image(ref string) *Image {
	if im, ok := d.images[ref]; ok {
		return im
	}
	for _, im := range d.images {
		if im.ID == ref {
			return im
		}
	}
	return nil
}

// ServeHTTP records the call and answers it.
func (d *Daemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	call := Call{
		Method: r.Method, URI: r.RequestURI, Host: r.Host, Header: r.Header.Clone(),
		Body: body, ContentLength: r.ContentLength, Chunked: len(r.TransferEncoding) > 0,
	}
	d.mu.Lock()
	d.calls = append(d.calls, call)
	hook := d.hook
	d.mu.Unlock()
	if hook != nil {
		if rep := hook(call); rep != nil {
			d.reply(w, r, rep)
			return
		}
	}
	d.route(w, r, call)
}

func (d *Daemon) reply(w http.ResponseWriter, r *http.Request, rep *Reply) {
	if rep.Delay > 0 {
		select {
		case <-time.After(rep.Delay):
		case <-r.Context().Done():
			if rep.OnCancel != nil {
				rep.OnCancel()
			}
			return
		}
	}
	if rep.Hang {
		<-r.Context().Done()
		if rep.OnCancel != nil {
			rep.OnCancel()
		}
		return
	}
	if rep.Upgrade {
		conn, buf, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
		_ = buf.Flush()
		return
	}
	for k, v := range rep.Header {
		w.Header().Set(k, v)
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	st := rep.Status
	if st == 0 {
		st = http.StatusOK
	}
	w.WriteHeader(st)
	_, _ = w.Write(rep.Body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func msg(w http.ResponseWriter, status int, m string) {
	writeJSON(w, status, map[string]string{"message": m})
}

func (d *Daemon) route(w http.ResponseWriter, r *http.Request, call Call) {
	path, rawQuery, _ := strings.Cut(call.URI, "?")
	q, _ := url.ParseQuery(rawQuery)
	switch path {
	case "/_ping":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "OK")
		return
	case "/version":
		d.mu.Lock()
		api, min := d.api, d.minAPI
		d.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]string{"ApiVersion": api, "MinAPIVersion": min, "Version": "fake"})
		return
	}
	rest, ok := strings.CutPrefix(path, "/v1.45/")
	if !ok {
		msg(w, http.StatusNotFound, "page not found")
		return
	}
	switch {
	case strings.HasPrefix(rest, "images/") && strings.HasSuffix(rest, "/json") && call.Method == "GET":
		d.imageJSON(w, strings.TrimSuffix(strings.TrimPrefix(rest, "images/"), "/json"))
	case rest == "containers/create" && call.Method == "POST":
		d.create(w, q.Get("name"), call.Body)
	case strings.HasPrefix(rest, "containers/"):
		d.container(w, r, call, strings.TrimPrefix(rest, "containers/"), q)
	default:
		msg(w, http.StatusNotFound, "page not found")
	}
}

func (d *Daemon) imageJSON(w http.ResponseWriter, escaped string) {
	ref, err := url.PathUnescape(escaped)
	if err != nil {
		msg(w, http.StatusBadRequest, "bad reference")
		return
	}
	d.mu.Lock()
	im := d.image(ref)
	var out map[string]any
	if im != nil {
		out = map[string]any{
			"Id": im.ID,
			"Config": map[string]any{
				"User": im.User, "Env": im.Env, "Labels": im.Labels,
				"Cmd": []string{"secret-image-cmd"},
			},
			"RepoDigests": []string{im.Ref},
		}
	}
	d.mu.Unlock()
	if im == nil {
		msg(w, http.StatusNotFound, "No such image: "+ref)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type createBody struct {
	Image           string            `json:"Image"`
	User            string            `json:"User"`
	Cmd             []string          `json:"Cmd"`
	Labels          map[string]string `json:"Labels"`
	NetworkDisabled bool              `json:"NetworkDisabled"`
	HostConfig      struct {
		Memory      int64    `json:"Memory"`
		NanoCpus    int64    `json:"NanoCpus"`
		PidsLimit   int64    `json:"PidsLimit"`
		NetworkMode string   `json:"NetworkMode"`
		Binds       []string `json:"Binds"`
	} `json:"HostConfig"`
}

func (d *Daemon) create(w http.ResponseWriter, name string, body []byte) {
	var cb createBody
	if err := json.Unmarshal(body, &cb); err != nil {
		msg(w, http.StatusBadRequest, "bad body")
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, taken := d.byName[name]; taken {
		msg(w, http.StatusConflict, "Conflict. The container name is already in use")
		return
	}
	im := d.image(cb.Image)
	if im == nil {
		msg(w, http.StatusNotFound, "No such image: "+cb.Image)
		return
	}
	c := &Container{
		ID: d.newID(name), Name: name, ImageID: im.ID, ImageRef: cb.Image,
		Labels: cb.Labels, User: cb.User, Cmd: cb.Cmd, Status: "created",
		Memory: cb.HostConfig.Memory, NanoCPUs: cb.HostConfig.NanoCpus, PidsLimit: cb.HostConfig.PidsLimit,
		NetworkMode: cb.HostConfig.NetworkMode, Binds: cb.HostConfig.Binds,
		Create: append([]byte(nil), body...),
	}
	d.byID[c.ID] = c
	d.byName[name] = c.ID
	writeJSON(w, http.StatusCreated, map[string]any{"Id": c.ID, "Warnings": []string{}})
}

func (c *Container) inspect() map[string]any {
	state := map[string]any{
		"Status": c.Status, "Running": c.Status == "running", "Pid": c.Pid, "ExitCode": c.ExitCode,
	}
	if c.Health != "" {
		state["Health"] = map[string]any{
			"Status": c.Health,
			"Log":    []map[string]any{{"Output": "secret-health-output"}},
		}
	}
	return map[string]any{
		"Id": c.ID, "Name": "/" + c.Name, "Image": c.ImageID,
		"Config": map[string]any{
			"Image": c.ImageRef, "User": c.User, "Cmd": c.Cmd, "Labels": c.Labels, "Env": c.Env,
		},
		"State": state,
		"HostConfig": map[string]any{
			"Memory": c.Memory, "NanoCpus": c.NanoCPUs, "PidsLimit": c.PidsLimit,
			"NetworkMode": c.NetworkMode, "Binds": c.Binds,
		},
		"Mounts": []map[string]any{{"Source": "/host/secret/path"}},
	}
}

func isHelper(c *Container) bool { _, ok := c.Labels["myrmidon.bot-helper"]; return ok }

func (d *Daemon) container(w http.ResponseWriter, r *http.Request, call Call, rest string, q url.Values) {
	ref, tail, _ := strings.Cut(rest, "/")
	d.mu.Lock()
	c := d.find(ref)
	if c == nil {
		d.mu.Unlock()
		msg(w, http.StatusNotFound, "No such container: "+ref)
		return
	}
	switch {
	case tail == "json" && call.Method == "GET":
		out := c.inspect()
		d.mu.Unlock()
		writeJSON(w, http.StatusOK, out)
	case tail == "" && call.Method == "DELETE":
		delete(d.byID, c.ID)
		delete(d.byName, c.Name)
		d.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	case tail == "start" && call.Method == "POST":
		st := http.StatusNoContent
		switch {
		case c.Status == "running":
			st = http.StatusNotModified
		case isHelper(c):
			c.Status = "exited"
		default:
			c.Status = "running"
			if c.Pid == 0 {
				c.Pid = 4000 + d.seq
			}
		}
		d.mu.Unlock()
		w.WriteHeader(st)
	case tail == "stop" && call.Method == "POST":
		st := http.StatusNoContent
		if c.Status != "running" {
			st = http.StatusNotModified
		}
		c.Status = "exited"
		d.mu.Unlock()
		w.WriteHeader(st)
	case tail == "restart" && call.Method == "POST":
		c.Status = "running"
		d.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	case tail == "rename" && call.Method == "POST":
		nn := q.Get("name")
		if _, taken := d.byName[nn]; taken {
			d.mu.Unlock()
			msg(w, http.StatusConflict, "Conflict. The container name is already in use")
			return
		}
		delete(d.byName, c.Name)
		c.Name = nn
		d.byName[nn] = c.ID
		d.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	case tail == "wait" && call.Method == "POST":
		d.mu.Unlock()
		d.wait(w, r, c.ID)
	case tail == "logs" && call.Method == "GET":
		logs := append([]byte(nil), c.Logs...)
		d.mu.Unlock()
		w.Header().Set("Content-Type", "application/vnd.docker.multiplexed-stream")
		w.WriteHeader(http.StatusOK)
		if len(logs) > 0 {
			hdr := make([]byte, 8)
			hdr[0] = 1
			binary.BigEndian.PutUint32(hdr[4:], uint32(len(logs)))
			_, _ = w.Write(hdr)
			_, _ = w.Write(logs)
		}
	case tail == "archive" && call.Method == "GET":
		marker := c.Marker
		d.mu.Unlock()
		if marker == nil || q.Get("path") != "/data/hermes/.myrmidon/applied.json" {
			msg(w, http.StatusNotFound, "Could not find the file in container")
			return
		}
		w.Header().Set("Content-Type", "application/x-tar")
		w.Header().Set("X-Docker-Container-Path-Stat", "e30=")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(marker)
	case tail == "archive" && call.Method == "PUT":
		c.Uploads = append(c.Uploads, Upload{Path: q.Get("path"), Body: append([]byte(nil), call.Body...)})
		d.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	default:
		d.mu.Unlock()
		msg(w, http.StatusNotFound, "page not found")
	}
}

// wait answers when the container is no longer running.
func (d *Daemon) wait(w http.ResponseWriter, r *http.Request, id string) {
	for {
		d.mu.Lock()
		c := d.byID[id]
		running := c != nil && c.Status == "running"
		code := 0
		if c != nil {
			code = c.ExitCode
		}
		d.mu.Unlock()
		if !running {
			writeJSON(w, http.StatusOK, map[string]any{"StatusCode": code})
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(5 * time.Millisecond):
		}
	}
}
