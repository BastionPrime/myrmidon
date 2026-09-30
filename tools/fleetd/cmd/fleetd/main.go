// tools/fleetd is the fleet service for a second machine (FLEETD-VMEXEC):
// it exposes the board's BotContainerDriver contract over HTTP for bot
// containers that live on its own host, enforcing the same fixed template
// the local driver enforces. Code layout mirrors tools/dockergate (Go,
// standard library only; see docs/myrmidon/fleetd-vmexec.md).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
)

// botStatus is the driver contract's BotContainerStatus.
type botStatus struct {
	BotKey      string  `json:"botKey"`
	State       string  `json:"state"`
	Image       string  `json:"image,omitempty"`
	RestartHash *string `json:"restartHash"`
	FilesHash   *string `json:"filesHash"`
}

// spec is the driver contract's BotContainerSpec.
type spec struct {
	BotKey    string            `json:"botKey"`
	Image     string            `json:"image"`
	MemoryMb  int64             `json:"memoryMb"`
	Cpus      float64           `json:"cpus"`
	PidsLimit int64             `json:"pidsLimit"`
	Network   string            `json:"network"`
	Labels    map[string]string `json:"labels,omitempty"`
}

// profileFile is one file of the compiled profile.
type profileFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    int    `json:"mode"`
	Secret  bool   `json:"secret"`
}

// profile is the driver contract's CompiledProfile.
type profile struct {
	BotKey      string        `json:"botKey"`
	Files       []profileFile `json:"files"`
	RestartHash string        `json:"restartHash"`
	FilesHash   string        `json:"filesHash"`
}

// config is the JSON configuration (see docs/myrmidon/fleetd-vmexec.md).
// Unknown keys are rejected at load time, the same discipline as dockergate.
type config struct {
	Listen   string `json:"listen"`
	Token    string `json:"token"`
	Upstream string `json:"upstream"`
	Bots     []bot  `json:"bots"`
}

type bot struct {
	BotKey      string  `json:"botKey"`
	MaxMemoryMb int64   `json:"maxMemoryMb"`
	MaxCpus     float64 `json:"maxCpus"`
	MaxPids     int64   `json:"maxPids"`
}

// strictDecode decodes data into out and rejects unknown keys.
func strictDecode(data []byte, out any) error {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return err
	}
	if dec.More() {
		return fmt.Errorf("trailing JSON content")
	}
	return nil
}

func main() {
	configPath := flag.String("config", "", "path to the JSON configuration")
	check := flag.Bool("check-config", false, "validate the configuration and exit")
	flag.Parse()
	if *configPath == "" {
		log.Fatal("--config is required")
	}
	raw, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatalf("read config: %v", err)
	}
	var cfg config
	if err := strictDecode(raw, &cfg); err != nil {
		log.Fatalf("config is invalid: %v", err)
	}
	if err := validate(&cfg); err != nil {
		log.Fatalf("config is invalid: %v", err)
	}
	if *check {
		fmt.Println("configuration is valid")
		return
	}
	srv := &server{cfg: &cfg}
	http.HandleFunc("/v1/bots", srv.requireAuth(srv.list))
	http.HandleFunc("/v1/bots/", srv.requireAuth(srv.route))
	log.Printf("fleetd listening on %s", cfg.Listen)
	log.Fatal(http.ListenAndServe(cfg.Listen, nil))
}

func validate(cfg *config) error {
	if cfg.Listen == "" {
		return fmt.Errorf("listen is required (host:port)")
	}
	if len(cfg.Token) < 32 {
		return fmt.Errorf("token must be at least 32 characters")
	}
	if cfg.Upstream == "" {
		cfg.Upstream = "/var/run/docker.sock"
	}
	if len(cfg.Bots) == 0 {
		return fmt.Errorf("at least one bots[] entry is required")
	}
	for i := range cfg.Bots {
		b := &cfg.Bots[i]
		if b.BotKey == "" || !validBotKey(b.BotKey) {
			return fmt.Errorf("bots[%d].botKey %q is invalid", i, b.BotKey)
		}
		if b.MaxMemoryMb <= 0 || b.MaxCpus <= 0 || b.MaxPids <= 0 {
			return fmt.Errorf("bots[%d] limits must be positive", i)
		}
	}
	return nil
}

func validBotKey(key string) bool {
	if len(key) < 1 || len(key) > 63 {
		return false
	}
	for i := 0; i < len(key); i++ {
		c := key[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return c(key[0]) != '-' && c(key[len(key)-1]) != '-'
}

type c byte

func (c c) in(set string) bool { return strings.ContainsRune(set, rune(c)) }

// server holds the per-request state; the Docker backend wiring is added by
// later commits (this one establishes the service skeleton, config check and
// the auth gate).
type server struct {
	cfg *config
}

// requireAuth wraps a handler with the static bearer token check.
func (s *server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if len(auth) <= len(prefix) || auth[:len(prefix)] != prefix || auth[len(prefix):] != s.cfg.Token {
			http.Error(w, "invalid_token", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// list answers GET /v1/bots.
func (s *server) list(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, map[string]any{"bots": []botStatus{}})
}

// route dispatches /v1/bots/{botKey}/... by method and suffix.
func (s *server) route(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/bots/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) == 0 || !validBotKey(parts[0]) {
		http.Error(w, "bad_bot_key", http.StatusBadRequest)
		return
	}
	botKey := parts[0]
	if len(parts) == 1 {
		http.Error(w, "route_not_allowed", http.StatusForbidden)
		return
	}
	action := parts[1]
	if !s.enrolled(botKey) {
		http.Error(w, "bot_not_enrolled", http.StatusForbidden)
		return
	}
	switch {
	case action == "status" && r.Method == http.MethodGet:
		writeJSON(w, botStatus{BotKey: botKey, State: "missing"})
	case action == "template-drift" && r.Method == http.MethodPost:
		var body struct {
			Spec spec `json:"spec"`
		}
		if err := decodeBody(r, &body); err != nil {
			http.Error(w, "body_not_allowed", http.StatusBadRequest)
			return
		}
		if err := s.checkSpec(botKey, &body.Spec); err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		writeJSON(w, map[string]bool{"drift": false})
	default:
		if r.Method == http.MethodPost || r.Method == http.MethodPut {
			http.Error(w, "route_not_allowed", http.StatusForbidden)
			return
		}
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) enrolled(botKey string) bool {
	for i := range s.cfg.Bots {
		if s.cfg.Bots[i].BotKey == botKey {
			return true
		}
	}
	return false
}

// checkSpec enforces the enrolled limits for the bot (a full create-body
// policy lands with the Docker wiring; the limits check is the seam).
func (s *server) checkSpec(botKey string, sp *spec) error {
	if sp.BotKey != botKey {
		return fmt.Errorf("name_label_mismatch")
	}
	for i := range s.cfg.Bots {
		b := &s.cfg.Bots[i]
		if b.BotKey != botKey {
			continue
		}
		if sp.MemoryMb > b.MaxMemoryMb {
			return fmt.Errorf("limit_exceeds_enrollment")
		}
		if sp.Cpus > b.MaxCpus {
			return fmt.Errorf("limit_exceeds_enrollment")
		}
		if sp.PidsLimit > b.MaxPids {
			return fmt.Errorf("limit_exceeds_enrollment")
		}
		return nil
	}
	return fmt.Errorf("bot_not_enrolled")
}

func decodeBody(r *http.Request, out any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(out)
}

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}
