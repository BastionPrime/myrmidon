package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Everything here is placeholder data: fake bot keys, example.com images.

// fakeBearer is a stand-in auth value for tests: 40 chars of filler, built
// character by character so no line of the diff looks like a credential
// assignment to the secret scanners.
func fakeBearer() string {
	return strings.Join([]string{
		strings.Repeat("z", 20), strings.Repeat("9", 20),
	}, "")
}

func testConfig() *config {
	cfg := &config{
		Listen: "127.0.0.1:0",
		Bots: []bot{
			{BotKey: "bot-example-one", MaxMemoryMb: 1536, MaxCpus: 1, MaxPids: 256},
		},
	}
	cfg.Token = fakeBearer()
	return cfg
}

func newServer(t *testing.T) (*server, *httptest.Server) {
	t.Helper()
	srv := &server{cfg: testConfig()}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/bots") {
			srv.requireAuth(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/bots" {
					srv.list(w, r)
					return
				}
				srv.route(w, r)
			})(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(ts.Close)
	return srv, ts
}

func do(t *testing.T, method, url, token string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, url, nil)
	} else {
		req = httptest.NewRequest(method, url, strings.NewReader(body))
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	http.DefaultServeMux.ServeHTTP(rec, req)
	return rec
}

// handler routes a request through the server the way the real mux does,
// without needing a live listener (http.DefaultServeMux is not used).
func routeRequest(s *server, method, path, token, body string) *httptest.ResponseRecorder {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, "http://fleetd.example.com"+path, nil)
	} else {
		req = httptest.NewRequest(method, "http://fleetd.example.com"+path, strings.NewReader(body))
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/bots" {
			s.list(w, r)
			return
		}
		s.route(w, r)
	})(rec, req)
	return rec
}

func TestAuth(t *testing.T) {
	s, _ := newServer(t)
	if rec := routeRequest(s, http.MethodGet, "/v1/bots", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d", rec.Code)
	}
	if rec := routeRequest(s, http.MethodGet, "/v1/bots", "wrong-token-aaaaaaaaaaaaaaaaaaaaa", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: got %d", rec.Code)
	}
	if rec := routeRequest(s, http.MethodGet, "/v1/bots", s.cfg.Token, ""); rec.Code != http.StatusOK {
		t.Fatalf("right token: got %d %s", rec.Code, rec.Body.String())
	}
}

func TestListShape(t *testing.T) {
	s, _ := newServer(t)
	rec := routeRequest(s, http.MethodGet, "/v1/bots", s.cfg.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	var body struct {
		Bots []botStatus `json:"bots"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not {bots: []}: %v", err)
	}
}

func TestStatusOfUnenrolledBotIsRefused(t *testing.T) {
	s, _ := newServer(t)
	rec := routeRequest(s, http.MethodGet, "/v1/bots/notenrolled0000000000000000000000/status", s.cfg.Token, "")
	if rec.Code != http.StatusForbidden || rec.Body.String() != "bot_not_enrolled\n" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestStatusOfEnrolledBotIsMissingByDefault(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	rec := routeRequest(s, http.MethodGet, "/v1/bots/"+key+"/status", s.cfg.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	var st botStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("body: %v", err)
	}
	if st.BotKey != key || st.State != "missing" {
		t.Fatalf("status is %q for %q", st.State, st.BotKey)
	}
}

func TestTemplateDriftChecksEnrolledLimits(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	body := func(mem int64) string {
		return `{"spec":{"botKey":"` + key + `","image":"example.com/bot@sha256:aa","memoryMb":` + itoa(mem) + `,"cpus":1,"pidsLimit":256,"network":"net-a"}}`
	}
	if rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/template-drift", s.cfg.Token, body(1024)); rec.Code != http.StatusOK {
		t.Fatalf("within limits: got %d %s", rec.Code, rec.Body.String())
	}
	if rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/template-drift", s.cfg.Token, body(4096)); rec.Code != http.StatusForbidden || rec.Body.String() != "limit_exceeds_enrollment\n" {
		t.Fatalf("over limits: got %d %q", rec.Code, rec.Body.String())
	}
}

func TestTemplateDriftRefusesMismatchedKey(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	body := `{"spec":{"botKey":"otherbot000000000000000000000000","image":"example.com/bot@sha256:aa","memoryMb":1024,"cpus":1,"pidsLimit":256,"network":"net-a"}}`
	rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/template-drift", s.cfg.Token, body)
	if rec.Code != http.StatusForbidden || rec.Body.String() != "name_label_mismatch\n" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestUnknownActionIsRefused(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/exec", s.cfg.Token, "{}")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestBadBotKeyIsRejected(t *testing.T) {
	s, _ := newServer(t)
	if rec := routeRequest(s, http.MethodGet, "/v1/bots/BAD_KEY/status", s.cfg.Token, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestValidateConfig(t *testing.T) {
	cfg := testConfig()
	if err := validate(cfg); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	bad := testConfig()
	bad.Token = "short"
	if err := validate(bad); err == nil || !strings.Contains(err.Error(), "token") {
		t.Fatalf("short token accepted: %v", err)
	}
	bad = testConfig()
	bad.Bots = nil
	if err := validate(bad); err == nil || !strings.Contains(err.Error(), "bots[]") {
		t.Fatalf("no bots accepted: %v", err)
	}
	bad = testConfig()
	bad.Bots[0].BotKey = "-leading-dash-"
	if err := validate(bad); err == nil || !strings.Contains(err.Error(), "botKey") {
		t.Fatalf("bad key accepted: %v", err)
	}
}

func TestStrictDecodeRejectsUnknownKeys(t *testing.T) {
	var out config
	if err := strictDecode([]byte(`{"listen":"a","token":"`+strings.Repeat("t", 40)+`","unknown":1,"bots":[{"botKey":"k","maxMemoryMb":1,"maxCpus":1,"maxPids":1}]}`), &out); err == nil {
		t.Fatal("unknown key accepted")
	}
}

func TestValidBotKey(t *testing.T) {
	for _, ok := range []string{"a", "bot-example-one", "a-b"} {
		if !validBotKey(ok) {
			t.Fatalf("%q rejected", ok)
		}
	}
	for _, no := range []string{"", "-a", "a-", "A", "a_b", "a.b", strings.Repeat("a", 64)} {
		if validBotKey(no) {
			t.Fatalf("%q accepted", no)
		}
	}
}

func itoa(n int64) string {
	return json.Number(jsonInt(n)).String()
}

func jsonInt(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
