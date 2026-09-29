// Package config loads and checks the configuration file of dockergate. An
// unknown key, at any level, refuses the start: a misspelled key must not turn
// into a silently missing restriction.
package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

// Caller modes.
const (
	// ModeContainerMainProcess pins the first child of the board container's
	// main process (spec section 4). It is the default.
	ModeContainerMainProcess = "container-main-process"
	// ModeUID trusts the uid and gid alone. It exists for CI, where there is no
	// board container, and check-config refuses it for the production root.
	ModeUID = "uid"
)

// ProdVolumeRoot is the volume root of a production host. The uid mode is
// refused with it.
const ProdVolumeRoot = "/srv/myrmidon-bots"

// SupportedAPIVersion is the only Docker API version dockergate speaks.
const SupportedAPIVersion = "1.45"

// Caller says who the board is.
type Caller struct {
	Container          string            `json:"container"`
	ContainerLabels    map[string]string `json:"containerLabels"`
	UID                uint32            `json:"uid"`
	GID                uint32            `json:"gid"`
	Argv               []string          `json:"argv"`
	MaxStartDelayTicks int64             `json:"maxStartDelayTicks"`
	Mode               string            `json:"mode"`
}

// Bot is the enrollment of one bot: the ceilings of its resources.
type Bot struct {
	BotKey      string  `json:"botKey"`
	MaxMemoryMB int64   `json:"maxMemoryMb"`
	MaxCPUs     float64 `json:"maxCpus"`
	MaxPids     int64   `json:"maxPids"`
}

// Limits are the limits and timeouts of section 11.1 and the rates of 9.2.
// A key that is left out keeps its default.
type Limits struct {
	MaxHeaderBytes        int     `json:"maxHeaderBytes"`
	ReadHeaderTimeoutSec  float64 `json:"readHeaderTimeoutSec"`
	BodyReadTimeoutSec    float64 `json:"bodyReadTimeoutSec"`
	MaxJSONBody           int     `json:"maxJsonBody"`
	MaxTarBody            int     `json:"maxTarBody"`
	UpstreamTimeoutSec    float64 `json:"upstreamTimeoutSec"`
	UpstreamStopSec       float64 `json:"upstreamStopTimeoutSec"`
	UpstreamWaitSec       float64 `json:"upstreamWaitTimeoutSec"`
	IdleConnTimeoutSec    float64 `json:"idleConnTimeoutSec"`
	MaxAuthenticatedConns int     `json:"maxAuthenticatedConns"`
	MaxInflightUpstream   int     `json:"maxInflightUpstream"`
	GlobalRate            float64 `json:"globalRate"`
	GlobalBurst           float64 `json:"globalBurst"`
	RejectPerPidRate      float64 `json:"rejectPerPidRate"`
	RejectPerPidBurst     float64 `json:"rejectPerPidBurst"`
	RejectBanSec          float64 `json:"rejectBanSec"`
	RejectGlobalRate      float64 `json:"rejectGlobalRate"`
	RejectGlobalBurst     float64 `json:"rejectGlobalBurst"`
	ResolveMinIntervalSec float64 `json:"resolveMinIntervalSec"`
	ResolvePollSec        float64 `json:"resolvePollIntervalSec"`

	// Per-bot rates (spec 9.2). The "per 10 min" ones are counts in a window of
	// RateWindowSec seconds.
	InspectRate     float64 `json:"inspectRate"`
	InspectBurst    float64 `json:"inspectBurst"`
	RateWindowSec   float64 `json:"rateWindowSec"`
	CreatePerWindow int     `json:"createPerWindow"`
	StartPerWindow  int     `json:"startPerWindow"`
	// RestartPerWindow and StopPerWindow: the stop bucket is shared by stop,
	// the delete of the main container and the rename.
	RestartPerWindow int `json:"restartPerWindow"`
	StopPerWindow    int `json:"stopPerWindow"`
	PutPerWindow     int `json:"putArchivePerWindow"`
}

// DefaultLimits are the values of the specification.
func DefaultLimits() Limits {
	return Limits{
		MaxHeaderBytes:        16 << 10,
		ReadHeaderTimeoutSec:  10,
		BodyReadTimeoutSec:    30,
		MaxJSONBody:           64 << 10,
		MaxTarBody:            16 << 20,
		UpstreamTimeoutSec:    65,
		UpstreamStopSec:       65,
		UpstreamWaitSec:       125,
		IdleConnTimeoutSec:    30,
		MaxAuthenticatedConns: 64,
		MaxInflightUpstream:   32,
		GlobalRate:            50,
		GlobalBurst:           100,
		RejectPerPidRate:      10,
		RejectPerPidBurst:     20,
		RejectBanSec:          60,
		RejectGlobalRate:      200,
		RejectGlobalBurst:     400,
		ResolveMinIntervalSec: 2,
		ResolvePollSec:        15,
		InspectRate:           5,
		InspectBurst:          20,
		RateWindowSec:         600,
		CreatePerWindow:       30,
		StartPerWindow:        30,
		RestartPerWindow:      6,
		StopPerWindow:         6,
		PutPerWindow:          30,
	}
}

// Sec converts a number of seconds to a duration.
func Sec(s float64) time.Duration { return time.Duration(s * float64(time.Second)) }

// Config is the configuration file.
type Config struct {
	Listen     string   `json:"listen"`
	Upstream   string   `json:"upstream"`
	APIVersion string   `json:"apiVersion"`
	Caller     *Caller  `json:"caller"`
	VolumeRoot string   `json:"volumeRoot"`
	Network    string   `json:"network"`
	Images     []string `json:"images"`
	Bots       []Bot    `json:"bots"`
	Limits     Limits   `json:"limits"`
	StatsFile  string   `json:"statsFile"`
}

var (
	imageRe   = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9-]+)*(?::[0-9]+)?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$`)
	botKeyRe  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	networkRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)
)

// Parse decodes and checks a configuration. The second result is the first 12
// hex characters of the sha256 of the raw bytes (the configHash of the stats).
func Parse(data []byte) (*Config, string, error) {
	cfg := &Config{Limits: DefaultLimits()}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(cfg); err != nil {
		return nil, "", fmt.Errorf("config: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, "", errors.New("config: data after the object")
	}
	if cfg.Caller != nil && cfg.Caller.MaxStartDelayTicks == 0 {
		cfg.Caller.MaxStartDelayTicks = 500
	}
	if cfg.Caller != nil && cfg.Caller.Mode == "" {
		cfg.Caller.Mode = ModeContainerMainProcess
	}
	if err := cfg.Validate(); err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(data)
	return cfg, hex.EncodeToString(sum[:])[:12], nil
}

// Load reads and checks the file at path.
func Load(path string) (*Config, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", fmt.Errorf("config: %w", err)
	}
	return Parse(data)
}

func absPath(name, p string) error {
	if !strings.HasPrefix(p, "/") || strings.Contains(p, "\x00") {
		return fmt.Errorf("config: %s must be an absolute path", name)
	}
	return nil
}

// Validate checks the values of a configuration.
func (c *Config) Validate() error {
	if err := absPath("listen", c.Listen); err != nil {
		return err
	}
	if err := absPath("upstream", c.Upstream); err != nil {
		return err
	}
	if err := absPath("statsFile", c.StatsFile); err != nil {
		return err
	}
	if c.APIVersion != SupportedAPIVersion {
		return fmt.Errorf("config: apiVersion must be %q", SupportedAPIVersion)
	}
	if c.Caller == nil {
		return errors.New("config: caller is required")
	}
	if c.Caller.UID == 0 {
		return errors.New("config: caller.uid must not be 0")
	}
	switch c.Caller.Mode {
	case ModeContainerMainProcess:
		if !networkRe.MatchString(c.Caller.Container) || len(c.Caller.ContainerLabels) == 0 || len(c.Caller.Argv) == 0 {
			return errors.New("config: caller.container (a container name), caller.containerLabels and caller.argv are required")
		}
		if c.Caller.MaxStartDelayTicks < 0 {
			return errors.New("config: caller.maxStartDelayTicks must not be negative")
		}
	case ModeUID:
		if c.VolumeRoot == ProdVolumeRoot {
			return errors.New("config: caller.mode uid is not allowed with the production volumeRoot")
		}
	default:
		return fmt.Errorf("config: caller.mode must be %q or %q", ModeContainerMainProcess, ModeUID)
	}
	if !strings.HasPrefix(c.VolumeRoot, "/") || strings.Contains(c.VolumeRoot, "..") ||
		strings.Contains(c.VolumeRoot, "//") || strings.HasSuffix(c.VolumeRoot, "/") || strings.Contains(c.VolumeRoot, "\x00") {
		return errors.New("config: volumeRoot must be an absolute path without .., // and a trailing /")
	}
	if !networkRe.MatchString(c.Network) {
		return errors.New("config: network is not a valid network name")
	}
	if len(c.Images) == 0 {
		return errors.New("config: images must not be empty")
	}
	seen := map[string]bool{}
	for _, img := range c.Images {
		if !imageRe.MatchString(img) {
			return errors.New("config: images must be repository@sha256:<digest>, without a tag or a glob")
		}
		if seen[img] {
			return errors.New("config: duplicate entry in images")
		}
		seen[img] = true
	}
	keys := map[string]bool{}
	for _, b := range c.Bots {
		if !botKeyRe.MatchString(b.BotKey) {
			return errors.New("config: bots[].botKey must be a lowercase uuid")
		}
		if keys[b.BotKey] {
			return errors.New("config: duplicate botKey in bots")
		}
		keys[b.BotKey] = true
		if b.MaxMemoryMB <= 0 || b.MaxPids <= 0 || !(b.MaxCPUs > 0) {
			return errors.New("config: the ceilings of a bot must be greater than zero")
		}
	}
	return c.Limits.validate()
}

func (l *Limits) validate() error {
	positive := []float64{
		float64(l.MaxHeaderBytes), l.ReadHeaderTimeoutSec, l.BodyReadTimeoutSec,
		float64(l.MaxJSONBody), float64(l.MaxTarBody), l.UpstreamTimeoutSec, l.UpstreamStopSec,
		l.UpstreamWaitSec, l.IdleConnTimeoutSec, float64(l.MaxAuthenticatedConns),
		float64(l.MaxInflightUpstream), l.GlobalRate, l.GlobalBurst, l.RejectPerPidRate,
		l.RejectPerPidBurst, l.RejectBanSec, l.RejectGlobalRate, l.RejectGlobalBurst,
		l.ResolveMinIntervalSec, l.ResolvePollSec, l.InspectRate, l.InspectBurst, l.RateWindowSec,
		float64(l.CreatePerWindow), float64(l.StartPerWindow), float64(l.RestartPerWindow),
		float64(l.StopPerWindow), float64(l.PutPerWindow),
	}
	for _, v := range positive {
		if !(v > 0) {
			return errors.New("config: every value of limits must be greater than zero")
		}
	}
	return nil
}

// Bot returns the enrollment of a bot.
func (c *Config) Bot(botKey string) (Bot, bool) {
	for _, b := range c.Bots {
		if b.BotKey == botKey {
			return b, true
		}
	}
	return Bot{}, false
}
