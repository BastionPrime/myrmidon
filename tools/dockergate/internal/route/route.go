// Package route matches the raw request-target of a client request against the
// allowlist of dockergate (A1..A12). There is no percent-decoding anywhere: the
// target is compared as a string with anchored templates, and the only escapes
// that can match are the literals that a template contains.
package route

import (
	"strings"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// APIPrefix is the only API version that dockergate speaks to clients and to the
// daemon.
const APIPrefix = "/v1.45/"

// NamePrefix is the prefix of every container name of a bot.
const NamePrefix = "myrmidon-bot-"

// Suffix is the role suffix of a container name.
type Suffix string

const (
	SuffixMain   Suffix = ""
	SuffixNext   Suffix = ".next"
	SuffixHelper Suffix = ".helper"
)

// Route IDs, as they are written to the log and to the counters.
const (
	A1  = "A1"
	A2  = "A2"
	A3  = "A3"
	A4  = "A4"
	A5  = "A5"
	A6  = "A6"
	A7  = "A7"
	A8  = "A8"
	A9  = "A9"
	A10 = "A10"
	A11 = "A11"
	A12 = "A12"
)

// Mount paths that a tar upload (A5) may target, keyed by the raw query value.
var archiveMounts = map[string]string{
	"%2Fdata%2Fhermes": "/data/hermes",
	"%2Fworkspace":     "/workspace",
	"%2Fscratch":       "/scratch",
}

const markerQuery = "path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json"

// Route is a parsed and matched request.
type Route struct {
	ID     string
	Method string
	// BotKey is the K of the target ("" for A1).
	BotKey string
	// Suffix is the role of the addressed container.
	Suffix Suffix
	// Name is the container name that the route addresses: for A4 the name to
	// create, for A12 the .next container (the new name is NameOf(BotKey, "")).
	Name string
	// ImageRef is the reference of an A1 request.
	ImageRef string
	// Mount is the container path of an A5 upload.
	Mount string
}

// NameOf builds the container name of a bot with a role suffix.
func NameOf(botKey string, suffix Suffix) string {
	return NamePrefix + botKey + string(suffix)
}

// IsBotKey reports whether s is a lowercase UUID: the K of the specification.
func IsBotKey(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < 36; i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
				return false
			}
		}
	}
	return true
}

// NameSegment is encodeURIComponent applied to every "/"-separated segment of
// an image reference, the way docker-driver.ts builds the A1 path.
func NameSegment(ref string) string {
	parts := strings.Split(ref, "/")
	for i, p := range parts {
		parts[i] = encodeURIComponent(p)
	}
	return strings.Join(parts, "/")
}

func encodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
			b.WriteByte(c)
		case strings.IndexByte("-_.!~*'()", c) >= 0:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
	}
	return b.String()
}

// Images is the set of A1 paths, computed once from the configured references.
type Images map[string]string

// NewImages computes the A1 path suffix ("images/<segment>/json") of each
// reference.
func NewImages(refs []string) Images {
	m := make(Images, len(refs))
	for _, ref := range refs {
		m["images/"+NameSegment(ref)+"/json"] = ref
	}
	return m
}

// splitName splits "myrmidon-bot-<K>[.next|.helper]" into its parts.
func splitName(name string) (key string, suffix Suffix, ok bool) {
	if !strings.HasPrefix(name, NamePrefix) {
		return "", "", false
	}
	rest := name[len(NamePrefix):]
	switch {
	case strings.HasSuffix(rest, string(SuffixNext)):
		suffix = SuffixNext
	case strings.HasSuffix(rest, string(SuffixHelper)):
		suffix = SuffixHelper
	}
	key = rest[:len(rest)-len(suffix)]
	if !IsBotKey(key) {
		return "", "", false
	}
	return key, suffix, true
}

func notAllowed() *deny.Error { return deny.New(deny.RouteNotAllowed) }

// Parse matches a request against the allowlist. target is the raw
// request-target exactly as the client sent it; images is the A1 set.
func Parse(method, target string, images Images) (*Route, *deny.Error) {
	// 5.1: origin-form only. absolute-form, authority-form and "*" are refused
	// before anything else is looked at.
	if !strings.HasPrefix(target, "/") {
		return nil, deny.New(deny.TargetForm)
	}
	switch method {
	case "GET", "POST", "PUT", "DELETE":
	default:
		return nil, deny.New(deny.MethodNotAllowed)
	}
	if !strings.HasPrefix(target, APIPrefix) {
		return nil, deny.New(deny.APIVersion)
	}
	rest := target[len(APIPrefix):]

	// A1: one of a fixed set of strings.
	if ref, ok := images[rest]; ok {
		if method != "GET" {
			return nil, notAllowed()
		}
		return &Route{ID: A1, Method: method, ImageRef: ref}, nil
	}

	const containers = "containers/"
	if !strings.HasPrefix(rest, containers) {
		return nil, notAllowed()
	}
	rest = rest[len(containers):]

	// A4: containers/create?name=<name>
	if q, ok := strings.CutPrefix(rest, "create?"); ok {
		name, ok := strings.CutPrefix(q, "name=")
		if !ok || method != "POST" {
			return nil, notAllowed()
		}
		key, suffix, ok := splitName(name)
		if !ok {
			return nil, notAllowed()
		}
		return &Route{ID: A4, Method: method, BotKey: key, Suffix: suffix, Name: name}, nil
	}

	// The name ends at the first "/" or "?".
	end := strings.IndexAny(rest, "/?")
	if end < 0 {
		return nil, notAllowed()
	}
	name, tail := rest[:end], rest[end:]
	key, suffix, ok := splitName(name)
	if !ok {
		return nil, notAllowed()
	}
	r := &Route{Method: method, BotKey: key, Suffix: suffix, Name: name}

	switch tail {
	case "?force=true&v=true":
		if method != "DELETE" {
			return nil, notAllowed()
		}
		r.ID = A9
	case "/json":
		if method != "GET" || suffix != SuffixMain {
			return nil, notAllowed()
		}
		r.ID = A2
	case "/archive?" + markerQuery:
		if method != "GET" || suffix != SuffixMain {
			return nil, notAllowed()
		}
		r.ID = A3
	case "/start":
		if method != "POST" || suffix == SuffixNext {
			return nil, notAllowed()
		}
		r.ID = A6
	case "/wait?condition=not-running":
		if method != "POST" || suffix != SuffixHelper {
			return nil, notAllowed()
		}
		r.ID = A7
	case "/logs?stdout=true&stderr=true&tail=20":
		if method != "GET" || suffix != SuffixHelper {
			return nil, notAllowed()
		}
		r.ID = A8
	case "/stop?t=30":
		if method != "POST" || suffix != SuffixMain {
			return nil, notAllowed()
		}
		r.ID = A10
	case "/restart?t=30":
		if method != "POST" || suffix != SuffixMain {
			return nil, notAllowed()
		}
		r.ID = A11
	default:
		if q, ok := strings.CutPrefix(tail, "/archive?path="); ok {
			// A5: the path parameter is one of three literals, then the fixed flag.
			const flag = "&noOverwriteDirNonDir=true"
			p, ok := strings.CutSuffix(q, flag)
			mount, known := archiveMounts[p]
			if !ok || !known || method != "PUT" || suffix != SuffixHelper {
				return nil, notAllowed()
			}
			r.ID = A5
			r.Mount = mount
			return r, nil
		}
		if q, ok := strings.CutPrefix(tail, "/rename?name="); ok {
			// A12: only .next -> the main name of the same bot.
			toKey, toSuffix, ok := splitName(q)
			if !ok || method != "POST" || suffix != SuffixNext || toSuffix != SuffixMain || toKey != key {
				return nil, notAllowed()
			}
			r.ID = A12
			return r, nil
		}
		return nil, notAllowed()
	}
	return r, nil
}
