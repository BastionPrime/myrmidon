package upstream

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/peer"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
)

// Limits of the answers that dockergate itself asks for.
const (
	MaxInspect = 1 << 20
	internalTO = 30 * time.Second
)

type health struct {
	Status *string `json:"Status,omitempty"`
}

// Container is what dockergate keeps of a container inspect. There is no field
// for the environment, the mounts or the health log: json.Unmarshal drops what
// has no field.
type Container struct {
	ID    string `json:"Id"`
	Name  string `json:"Name"`
	Image string `json:"Image"`

	Config struct {
		Image  *string           `json:"Image"`
		User   string            `json:"User"`
		Cmd    []string          `json:"Cmd"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`

	State struct {
		Status   *string `json:"Status"`
		Running  bool    `json:"Running"`
		Pid      int     `json:"Pid"`
		ExitCode *int    `json:"ExitCode"`
		Health   *health `json:"Health"`
	} `json:"State"`

	HostConfig struct {
		Memory      *int64  `json:"Memory"`
		NanoCpus    *int64  `json:"NanoCpus"`
		PidsLimit   *int64  `json:"PidsLimit"`
		NetworkMode *string `json:"NetworkMode"`
	} `json:"HostConfig"`
}

// Status is State.Status, "" when the daemon did not send it.
func (c *Container) Status() string {
	if c.State.Status == nil {
		return ""
	}
	return *c.State.Status
}

// trimmedContainer is the answer to A2 (spec 6.3): the fields that
// DockerInspect of the driver reads, and nothing else.
type trimmedContainer struct {
	ID     string `json:"Id"`
	Image  string `json:"Image"`
	Config struct {
		Image  *string           `json:"Image,omitempty"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Status   *string `json:"Status,omitempty"`
		ExitCode *int    `json:"ExitCode,omitempty"`
		Health   *health `json:"Health,omitempty"`
	} `json:"State"`
	HostConfig struct {
		Memory      *int64  `json:"Memory,omitempty"`
		NanoCpus    *int64  `json:"NanoCpus,omitempty"`
		PidsLimit   *int64  `json:"PidsLimit,omitempty"`
		NetworkMode *string `json:"NetworkMode,omitempty"`
	} `json:"HostConfig"`
}

func encode(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

func labelsOrEmpty(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

// Trimmed is the body of the answer to A2.
func (c *Container) Trimmed() []byte {
	var t trimmedContainer
	t.ID = c.ID
	t.Image = c.Image
	t.Config.Image = c.Config.Image
	t.Config.Labels = labelsOrEmpty(c.Config.Labels)
	t.State.Status = c.State.Status
	t.State.ExitCode = c.State.ExitCode
	t.State.Health = c.State.Health
	t.HostConfig.Memory = c.HostConfig.Memory
	t.HostConfig.NanoCpus = c.HostConfig.NanoCpus
	t.HostConfig.PidsLimit = c.HostConfig.PidsLimit
	t.HostConfig.NetworkMode = c.HostConfig.NetworkMode
	return encode(t)
}

func decodeInto(body []byte, v any) *deny.Error {
	if err := json.Unmarshal(body, v); err != nil {
		return deny.New(deny.UpstreamError).WithDetail("decode")
	}
	return nil
}

// ParseContainer decodes the answer of an inspect.
func ParseContainer(body []byte) (*Container, *deny.Error) {
	var c Container
	if derr := decodeInto(body, &c); derr != nil {
		return nil, derr
	}
	if c.ID == "" {
		return nil, deny.New(deny.UpstreamError).WithDetail("no_id")
	}
	return &c, nil
}

// Inspect asks the daemon about a container by name or by Id. A missing
// container is (nil, 404, nil).
func (c *Client) Inspect(ctx context.Context, ref string) (*Container, int, *deny.Error) {
	status, body, derr := c.Fetch(ctx, Request{Method: "GET", Target: Prefix + "/containers/" + ref + "/json"}, internalTO, MaxInspect)
	if derr != nil {
		return nil, 0, derr
	}
	switch status {
	case http.StatusOK:
		ct, derr := ParseContainer(body)
		return ct, status, derr
	case http.StatusNotFound:
		return nil, status, nil
	}
	return nil, status, deny.New(deny.UpstreamError).WithDetail("inspect_status_" + strconv.Itoa(status))
}

// Board implements peer.BoardInspector.
func (c *Client) Board(ctx context.Context, container string) (peer.BoardState, error) {
	ct, status, derr := c.Inspect(ctx, container)
	if derr != nil {
		return peer.BoardState{}, derr
	}
	if ct == nil {
		return peer.BoardState{}, deny.New(deny.UpstreamError).WithDetail("board_status_" + strconv.Itoa(status))
	}
	return peer.BoardState{ID: ct.ID, Running: ct.State.Running, Pid: ct.State.Pid, Labels: ct.Config.Labels}, nil
}

// image is the part of an image inspect that dockergate reads.
type image struct {
	ID     string `json:"Id"`
	Config struct {
		User   string            `json:"User"`
		Env    []string          `json:"Env"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
}

// TrimImage is the body of the answer to A1: the labels, which are all that
// the driver reads.
func TrimImage(body []byte) ([]byte, *deny.Error) {
	var img image
	if derr := decodeInto(body, &img); derr != nil {
		return nil, derr
	}
	var out struct {
		ID     string `json:"Id"`
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	out.ID = img.ID
	out.Config.Labels = labelsOrEmpty(img.Config.Labels)
	return encode(out), nil
}

// ParseImage reduces an image inspect to what the self-check needs. The
// values of the environment are dropped here except for PATH.
func ParseImage(body []byte) (*policy.ImageInfo, *deny.Error) {
	var img image
	if derr := decodeInto(body, &img); derr != nil {
		return nil, derr
	}
	info := &policy.ImageInfo{ID: img.ID, Labels: img.Config.Labels, User: img.Config.User}
	pathCount := 0
	for _, kv := range img.Config.Env {
		name, val, _ := strings.Cut(kv, "=")
		switch name {
		case "PATH":
			pathCount++
			info.HasPath = true
			info.Path = val
		case "ENV":
			info.HasENV = true
		case "BASH_ENV":
			info.HasBashEnv = true
		}
	}
	if pathCount > 1 {
		// Two PATH entries: which one wins depends on the reader. Refuse.
		info.Path = ""
	}
	return info, nil
}

// InspectImage asks the daemon about an image by reference. A missing image is
// (nil, 404, nil).
func (c *Client) InspectImage(ctx context.Context, path string) (*policy.ImageInfo, int, *deny.Error) {
	status, body, derr := c.Fetch(ctx, Request{Method: "GET", Target: Prefix + "/images/" + path + "/json"}, internalTO, MaxInspect)
	if derr != nil {
		return nil, 0, derr
	}
	switch status {
	case http.StatusOK:
		info, derr := ParseImage(body)
		return info, status, derr
	case http.StatusNotFound:
		return nil, status, nil
	}
	return nil, status, deny.New(deny.UpstreamError).WithDetail("image_status_" + strconv.Itoa(status))
}

// TrimCreate is the body of the answer to A4.
func TrimCreate(body []byte) ([]byte, *deny.Error) {
	var in struct {
		ID       string   `json:"Id"`
		Warnings []string `json:"Warnings"`
	}
	if derr := decodeInto(body, &in); derr != nil {
		return nil, derr
	}
	if in.Warnings == nil {
		in.Warnings = []string{}
	}
	return encode(in), nil
}

// Ping is the GET /_ping that dockergate sends for its own stats.
func (c *Client) Ping(ctx context.Context) error {
	status, _, derr := c.Fetch(ctx, Request{Method: "GET", Target: "/_ping"}, 5*time.Second, 1024)
	if derr != nil {
		return derr
	}
	if status != http.StatusOK {
		return deny.New(deny.UpstreamError).WithDetail("ping_status_" + strconv.Itoa(status))
	}
	return nil
}

// Version is the answer of GET /version, reduced to the API versions.
type Version struct {
	APIVersion    string `json:"ApiVersion"`
	MinAPIVersion string `json:"MinAPIVersion"`
}

// Version asks the daemon which API versions it speaks.
func (c *Client) Version(ctx context.Context) (Version, error) {
	status, body, derr := c.Fetch(ctx, Request{Method: "GET", Target: "/version"}, 10*time.Second, MaxInspect)
	if derr != nil {
		return Version{}, derr
	}
	if status != http.StatusOK {
		return Version{}, deny.New(deny.UpstreamError).WithDetail("version_status_" + strconv.Itoa(status))
	}
	var v Version
	if derr := decodeInto(body, &v); derr != nil {
		return Version{}, derr
	}
	return v, nil
}

func parseMinor(s string) (major, minor int, ok bool) {
	a, b, found := strings.Cut(s, ".")
	if !found {
		return 0, 0, false
	}
	ma, err1 := strconv.Atoi(a)
	mi, err2 := strconv.Atoi(b)
	return ma, mi, err1 == nil && err2 == nil
}

// SupportsAPI reports whether v.MinAPIVersion <= want <= v.APIVersion.
func (v Version) SupportsAPI(want string) bool {
	wa, wi, ok := parseMinor(want)
	if !ok {
		return false
	}
	hiMa, hiMi, ok := parseMinor(v.APIVersion)
	if !ok {
		return false
	}
	loMa, loMi, ok := parseMinor(v.MinAPIVersion)
	if !ok {
		return false
	}
	le := func(a1, b1, a2, b2 int) bool { return a1 < a2 || (a1 == a2 && b1 <= b2) }
	return le(loMa, loMi, wa, wi) && le(wa, wi, hiMa, hiMi)
}
