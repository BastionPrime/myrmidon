package policy_test

import (
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
)

func goodImage() *policy.ImageInfo {
	return &policy.ImageInfo{
		ID:      "sha256:" + strings.Repeat("ab", 32),
		Labels:  map[string]string{policy.RuntimeContractLabel: "1"},
		User:    "10001:10001",
		Path:    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		HasPath: true,
	}
}

func TestCheckImageAccepts(t *testing.T) {
	if err := policy.CheckImage(goodImage()); err != nil {
		t.Fatalf("denied: %s (%s)", err.Code, err.Detail)
	}
	// A directory whose name only starts like a writable one is not writable
	// by the bot.
	for _, p := range []string{"/data2/bin", "/tmpx/bin", "/workspaces", "/scratchpad", "/opt/venv/bin", "/usr/bin"} {
		i := goodImage()
		i.Path = p + ":/usr/bin"
		if err := policy.CheckImage(i); err != nil {
			t.Errorf("PATH %q denied: %s (%s)", p, err.Code, err.Detail)
		}
	}
}

// RT1_3: the root helper runs with the image's PATH; nothing the bot can write
// may be on it, and no shell start-up file may be named.
func TestRedTeam_RT1_3_ImagePath(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*policy.ImageInfo)
		detail string
	}{
		{"no contract label", func(i *policy.ImageInfo) { delete(i.Labels, policy.RuntimeContractLabel) }, "contract_label"},
		{"contract label 2", func(i *policy.ImageInfo) { i.Labels[policy.RuntimeContractLabel] = "2" }, "contract_label"},
		{"contract label empty", func(i *policy.ImageInfo) { i.Labels[policy.RuntimeContractLabel] = "" }, "contract_label"},
		{"contract label true", func(i *policy.ImageInfo) { i.Labels[policy.RuntimeContractLabel] = "true" }, "contract_label"},
		{"nil labels", func(i *policy.ImageInfo) { i.Labels = nil }, "contract_label"},
		{"user root", func(i *policy.ImageInfo) { i.User = "0:0" }, "user"},
		{"user empty", func(i *policy.ImageInfo) { i.User = "" }, "user"},
		{"user without group", func(i *policy.ImageInfo) { i.User = "10001" }, "user"},
		{"user by name", func(i *policy.ImageInfo) { i.User = "hermes" }, "user"},
		{"user with a space", func(i *policy.ImageInfo) { i.User = "10001:10001 " }, "user"},
		{"id short", func(i *policy.ImageInfo) { i.ID = i.ID[:len(i.ID)-1] }, "id"},
		{"id uppercase", func(i *policy.ImageInfo) { i.ID = strings.ToUpper(i.ID) }, "id"},
		{"id empty", func(i *policy.ImageInfo) { i.ID = "" }, "id"},
		{"no PATH", func(i *policy.ImageInfo) { i.HasPath, i.Path = false, "" }, "path_missing"},
		{"ENV set", func(i *policy.ImageInfo) { i.HasENV = true }, "shell_env"},
		{"BASH_ENV set", func(i *policy.ImageInfo) { i.HasBashEnv = true }, "shell_env"},
		{"empty PATH", func(i *policy.ImageInfo) { i.Path = "" }, "path_element"},
		{"leading colon", func(i *policy.ImageInfo) { i.Path = ":/usr/bin" }, "path_element"},
		{"trailing colon", func(i *policy.ImageInfo) { i.Path = "/usr/bin:" }, "path_element"},
		{"double colon", func(i *policy.ImageInfo) { i.Path = "/usr/bin::/bin" }, "path_element"},
		{"dot element", func(i *policy.ImageInfo) { i.Path = "/usr/bin:." }, "path_element"},
		{"relative element", func(i *policy.ImageInfo) { i.Path = "bin:/usr/bin" }, "path_element"},
		{"dot dot element", func(i *policy.ImageInfo) { i.Path = "/usr/bin:.." }, "path_element"},
		{"trailing slash", func(i *policy.ImageInfo) { i.Path = "/usr/bin/" }, "path_element"},
		{"double slash", func(i *policy.ImageInfo) { i.Path = "/usr//bin" }, "path_element"},
		{"dot inside", func(i *policy.ImageInfo) { i.Path = "/usr/./bin" }, "path_element"},
		{"traversal into data", func(i *policy.ImageInfo) { i.Path = "/usr/../data/bin" }, "path_element"},
		{"data root", func(i *policy.ImageInfo) { i.Path = "/data:/usr/bin" }, "path_unsafe"},
		{"data hermes", func(i *policy.ImageInfo) { i.Path = "/usr/bin:/data/hermes/bin" }, "path_unsafe"},
		{"workspace", func(i *policy.ImageInfo) { i.Path = "/workspace" }, "path_unsafe"},
		{"workspace bin", func(i *policy.ImageInfo) { i.Path = "/workspace/bin:/usr/bin" }, "path_unsafe"},
		{"scratch", func(i *policy.ImageInfo) { i.Path = "/scratch" }, "path_unsafe"},
		{"scratch deep", func(i *policy.ImageInfo) { i.Path = "/usr/bin:/scratch/a/b" }, "path_unsafe"},
		{"tmp", func(i *policy.ImageInfo) { i.Path = "/tmp" }, "path_unsafe"},
		{"tmp bin", func(i *policy.ImageInfo) { i.Path = "/tmp/bin:/usr/bin" }, "path_unsafe"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			i := goodImage()
			tc.mutate(i)
			err := policy.CheckImage(i)
			if err == nil {
				t.Fatal("accepted")
			}
			if err.Code != deny.ImageContract || err.Detail != tc.detail {
				t.Fatalf("denied as %s (%s), want %s (%s)", err.Code, err.Detail, deny.ImageContract, tc.detail)
			}
		})
	}
}
