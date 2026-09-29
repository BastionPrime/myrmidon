package policy

import (
	"path"
	"regexp"
	"strings"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// RuntimeContractLabel is the label an image carries when it is built for the
// bot runtime (template.ts).
const RuntimeContractLabel = "myrmidon.bot-runtime.contract"

// BotUser is Config.User of an allowed image.
const BotUser = "10001:10001"

var imageIDRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// IsImageID reports whether s has the form of an image Id.
func IsImageID(s string) bool { return imageIDRe.MatchString(s) }

// ImageInfo is what dockergate keeps of an image inspect. The environment of
// the image is not kept: only PATH (needed for the check) and the presence of
// two names are read from it, then it is dropped, and no value of it is ever
// logged or returned.
type ImageInfo struct {
	ID      string
	Labels  map[string]string
	User    string
	Path    string
	HasPath bool
	// HasENV and HasBashEnv are the presence of the variables ENV and BASH_ENV,
	// which make a shell read a file at start.
	HasENV     bool
	HasBashEnv bool
}

// unsafeRoots are the directories that a bot writes to. A PATH element in or
// under one of them would let the bot choose what the root helper runs.
var unsafeRoots = []string{"/data", "/workspace", "/scratch", "/tmp"}

// CheckImage is the self-check of an image before any create (spec 7.5).
func CheckImage(info *ImageInfo) *deny.Error {
	bad := func(detail string) *deny.Error {
		return deny.New(deny.ImageContract).WithDetail(detail)
	}
	if info.Labels[RuntimeContractLabel] != "1" {
		return bad("contract_label")
	}
	if info.User != BotUser {
		return bad("user")
	}
	if !IsImageID(info.ID) {
		return bad("id")
	}
	if !info.HasPath {
		return bad("path_missing")
	}
	if info.HasENV || info.HasBashEnv {
		return bad("shell_env")
	}
	for _, el := range strings.Split(info.Path, ":") {
		if el == "" || el == "." || !strings.HasPrefix(el, "/") || path.Clean(el) != el {
			return bad("path_element")
		}
		for _, u := range unsafeRoots {
			if el == u || strings.HasPrefix(el, u+"/") {
				return bad("path_unsafe")
			}
		}
	}
	return nil
}
