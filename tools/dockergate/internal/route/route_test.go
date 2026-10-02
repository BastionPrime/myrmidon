package route

import (
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

const (
	keyA = "0a1b2c3d-1111-2222-3333-444455556666"
	keyB = "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff"
	ref1 = "ghcr.io/itkadr-git/myrmidon-hermes@sha256:abababababababababababababababababababababababababababababababab"
	ref2 = "ghcr.io/itkadr-git/myrmidon-hermes-old@sha256:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
)

const (
	nameA     = NamePrefix + keyA
	nameANext = nameA + ".next"
	nameAHelp = nameA + ".helper"
	nameB     = NamePrefix + keyB
)

func images() Images { return NewImages([]string{ref1, ref2}) }

func TestAllow(t *testing.T) {
	const v = "/v1.45/"
	archive := func(p string) string {
		return v + "containers/" + nameAHelp + "/archive?path=" + p + "&noOverwriteDirNonDir=true"
	}
	cases := []struct {
		name   string
		method string
		target string
		want   Route
	}{
		{"A1 first image", "GET", v + "images/" + NameSegment(ref1) + "/json", Route{ID: A1, ImageRef: ref1}},
		{"A1 second image", "GET", v + "images/" + NameSegment(ref2) + "/json", Route{ID: A1, ImageRef: ref2}},
		{"A2", "GET", v + "containers/" + nameA + "/json", Route{ID: A2, BotKey: keyA, Name: nameA}},
		{"A3", "GET", v + "containers/" + nameA + "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json", Route{ID: A3, BotKey: keyA, Name: nameA}},
		{"A4 main", "POST", v + "containers/create?name=" + nameA, Route{ID: A4, BotKey: keyA, Name: nameA}},
		{"A4 next", "POST", v + "containers/create?name=" + nameANext, Route{ID: A4, BotKey: keyA, Suffix: SuffixNext, Name: nameANext}},
		{"A4 helper", "POST", v + "containers/create?name=" + nameAHelp, Route{ID: A4, BotKey: keyA, Suffix: SuffixHelper, Name: nameAHelp}},
		{"A5 hermes", "PUT", archive("%2Fdata%2Fhermes"), Route{ID: A5, BotKey: keyA, Suffix: SuffixHelper, Name: nameAHelp, Mount: "/data/hermes"}},
		{"A5 workspace", "PUT", archive("%2Fworkspace"), Route{ID: A5, BotKey: keyA, Suffix: SuffixHelper, Name: nameAHelp, Mount: "/workspace"}},
		{"A5 scratch", "PUT", archive("%2Fscratch"), Route{ID: A5, BotKey: keyA, Suffix: SuffixHelper, Name: nameAHelp, Mount: "/scratch"}},
		{"A6 main", "POST", v + "containers/" + nameA + "/start", Route{ID: A6, BotKey: keyA, Name: nameA}},
		{"A6 helper", "POST", v + "containers/" + nameAHelp + "/start", Route{ID: A6, BotKey: keyA, Suffix: SuffixHelper, Name: nameAHelp}},
		{"A7", "POST", v + "containers/" + nameAHelp + "/wait?condition=not-running", Route{ID: A7, BotKey: keyA, Suffix: SuffixHelper, Name: nameAHelp}},
		{"A8", "GET", v + "containers/" + nameAHelp + "/logs?stdout=true&stderr=true&tail=20", Route{ID: A8, BotKey: keyA, Suffix: SuffixHelper, Name: nameAHelp}},
		{"A9 main", "DELETE", v + "containers/" + nameA + "?force=true&v=true", Route{ID: A9, BotKey: keyA, Name: nameA}},
		{"A9 next", "DELETE", v + "containers/" + nameANext + "?force=true&v=true", Route{ID: A9, BotKey: keyA, Suffix: SuffixNext, Name: nameANext}},
		{"A9 helper", "DELETE", v + "containers/" + nameAHelp + "?force=true&v=true", Route{ID: A9, BotKey: keyA, Suffix: SuffixHelper, Name: nameAHelp}},
		{"A10", "POST", v + "containers/" + nameA + "/stop?t=30", Route{ID: A10, BotKey: keyA, Name: nameA}},
		{"A11", "POST", v + "containers/" + nameA + "/restart?t=30", Route{ID: A11, BotKey: keyA, Name: nameA}},
		{"A12", "POST", v + "containers/" + nameANext + "/rename?name=" + nameA, Route{ID: A12, BotKey: keyA, Suffix: SuffixNext, Name: nameANext}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Parse(tc.method, tc.target, images())
			if err != nil {
				t.Fatalf("denied: %s", err.Code)
			}
			tc.want.Method = tc.method
			if *got != tc.want {
				t.Fatalf("route %+v, want %+v", *got, tc.want)
			}
		})
	}
}

// Every request must fail with the given code. The list is the deny side of
// the allow table above: each template with a piece changed.
func TestDenyTable(t *testing.T) {
	const v = "/v1.45/"
	c := v + "containers/"
	archiveHelper := func(q string) string { return c + nameAHelp + "/archive?" + q }
	cases := []struct {
		name, method, target, code string
	}{
		// origin-form only
		{"absolute form", "GET", "http://docker/v1.45/containers/" + nameA + "/json", deny.TargetForm},
		{"asterisk form", "GET", "*", deny.TargetForm},
		{"authority form", "GET", "docker:80", deny.TargetForm},
		{"empty target", "GET", "", deny.TargetForm},
		// methods
		{"HEAD", "HEAD", c + nameA + "/json", deny.MethodNotAllowed},
		{"HEAD archive", "HEAD", c + nameA + "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json", deny.MethodNotAllowed},
		{"PATCH", "PATCH", c + nameA + "/json", deny.MethodNotAllowed},
		{"OPTIONS", "OPTIONS", c + nameA + "/json", deny.MethodNotAllowed},
		{"CONNECT", "CONNECT", c + nameA + "/json", deny.MethodNotAllowed},
		{"lowercase get", "get", c + nameA + "/json", deny.MethodNotAllowed},
		// API version
		{"no version", "GET", "/containers/" + nameA + "/json", deny.APIVersion},
		{"older version", "GET", "/v1.44/containers/" + nameA + "/json", deny.APIVersion},
		{"newer version", "GET", "/v1.46/containers/" + nameA + "/json", deny.APIVersion},
		{"longer version", "GET", "/v1.450/containers/" + nameA + "/json", deny.APIVersion},
		{"uppercase version", "GET", "/V1.45/containers/" + nameA + "/json", deny.APIVersion},
		{"version without slash", "GET", "/v1.45", deny.APIVersion},
		{"unversioned ping", "GET", "/_ping", deny.APIVersion},
		{"unversioned version", "GET", "/version", deny.APIVersion},

		// A1
		{"A1 unknown image", "GET", v + "images/" + NameSegment("ghcr.io/itkadr-git/other@sha256:"+strings.Repeat("ab", 32)) + "/json", deny.RouteNotAllowed},
		{"A1 unescaped ref", "GET", v + "images/" + ref1 + "/json", deny.RouteNotAllowed},
		{"A1 lowercase escapes", "GET", v + "images/" + strings.ReplaceAll(NameSegment(ref1), "%3A", "%3a") + "/json", deny.RouteNotAllowed},
		{"A1 POST", "POST", v + "images/" + NameSegment(ref1) + "/json", deny.RouteNotAllowed},
		{"A1 DELETE", "DELETE", v + "images/" + NameSegment(ref1) + "/json", deny.RouteNotAllowed},
		{"A1 DELETE image", "DELETE", v + "images/" + NameSegment(ref1), deny.RouteNotAllowed},
		{"A1 query", "GET", v + "images/" + NameSegment(ref1) + "/json?x=1", deny.RouteNotAllowed},
		{"A1 trailing slash", "GET", v + "images/" + NameSegment(ref1) + "/json/", deny.RouteNotAllowed},
		{"A1 dot segment", "GET", v + "images/./" + NameSegment(ref1) + "/json", deny.RouteNotAllowed},
		{"A1 history", "GET", v + "images/" + NameSegment(ref1) + "/history", deny.RouteNotAllowed},
		{"A1 push", "POST", v + "images/" + NameSegment(ref1) + "/push", deny.RouteNotAllowed},
		{"A1 tag", "POST", v + "images/" + NameSegment(ref1) + "/tag?repo=x", deny.RouteNotAllowed},
		{"A1 get", "GET", v + "images/" + NameSegment(ref1) + "/get", deny.RouteNotAllowed},

		// A2 and A3 address the main container only
		{"A2 helper", "GET", c + nameAHelp + "/json", deny.RouteNotAllowed},
		{"A2 next", "GET", c + nameANext + "/json", deny.RouteNotAllowed},
		{"A2 POST", "POST", c + nameA + "/json", deny.RouteNotAllowed},
		{"A2 query", "GET", c + nameA + "/json?size=true", deny.RouteNotAllowed},
		{"A2 empty query", "GET", c + nameA + "/json?", deny.RouteNotAllowed},
		{"A3 other file", "GET", c + nameA + "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fother.json", deny.RouteNotAllowed},
		{"A3 traversal", "GET", c + nameA + "/archive?path=%2Fdata%2Fhermes%2F..%2F..%2Fetc%2Fpasswd", deny.RouteNotAllowed},
		{"A3 decoded path", "GET", c + nameA + "/archive?path=/data/hermes/.myrmidon/applied.json", deny.RouteNotAllowed},
		{"A3 lowercase escape", "GET", c + nameA + "/archive?path=%2fdata%2fhermes%2f.myrmidon%2fapplied.json", deny.RouteNotAllowed},
		{"A3 extra query", "GET", c + nameA + "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json&x=1", deny.RouteNotAllowed},
		{"A3 no query", "GET", c + nameA + "/archive", deny.RouteNotAllowed},
		{"A3 helper", "GET", c + nameAHelp + "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json", deny.RouteNotAllowed},
		{"A3 PUT", "PUT", c + nameA + "/archive?path=%2Fdata%2Fhermes%2F.myrmidon%2Fapplied.json", deny.RouteNotAllowed},

		// A4
		{"A4 GET", "GET", c + "create?name=" + nameA, deny.RouteNotAllowed},
		{"A4 no name", "POST", c + "create", deny.RouteNotAllowed},
		{"A4 empty query", "POST", c + "create?", deny.RouteNotAllowed},
		{"A4 empty name", "POST", c + "create?name=", deny.RouteNotAllowed},
		{"A4 extra query", "POST", c + "create?name=" + nameA + "&x=1", deny.RouteNotAllowed},
		{"A4 reordered query", "POST", c + "create?x=1&name=" + nameA, deny.RouteNotAllowed},
		{"A4 platform query", "POST", c + "create?name=" + nameA + "&platform=linux", deny.RouteNotAllowed},
		{"A4 foreign name", "POST", c + "create?name=other", deny.RouteNotAllowed},
		{"A4 unknown suffix", "POST", c + "create?name=" + nameA + ".other", deny.RouteNotAllowed},
		{"A4 double suffix", "POST", c + "create?name=" + nameA + ".next.next", deny.RouteNotAllowed},
		{"A4 suffix pair", "POST", c + "create?name=" + nameA + ".next.helper", deny.RouteNotAllowed},
		{"A4 uppercase key", "POST", c + "create?name=" + NamePrefix + strings.ToUpper(keyA), deny.RouteNotAllowed},
		{"A4 short key", "POST", c + "create?name=" + NamePrefix + keyA[:35], deny.RouteNotAllowed},
		{"A4 percent in name", "POST", c + "create?name=" + NamePrefix + "%30a1b2c3d-1111-2222-3333-444455556666", deny.RouteNotAllowed},
		{"A4 name with slash", "POST", c + "create?name=" + nameA + "/x", deny.RouteNotAllowed},
		{"A4 trailing slash", "POST", c + "create/?name=" + nameA, deny.RouteNotAllowed},

		// A5
		{"A5 GET", "GET", archiveHelper("path=%2Fscratch&noOverwriteDirNonDir=true"), deny.RouteNotAllowed},
		{"A5 POST", "POST", archiveHelper("path=%2Fscratch&noOverwriteDirNonDir=true"), deny.RouteNotAllowed},
		{"A5 main", "PUT", c + nameA + "/archive?path=%2Fscratch&noOverwriteDirNonDir=true", deny.RouteNotAllowed},
		{"A5 next", "PUT", c + nameANext + "/archive?path=%2Fscratch&noOverwriteDirNonDir=true", deny.RouteNotAllowed},
		{"A5 other path", "PUT", archiveHelper("path=%2Fetc&noOverwriteDirNonDir=true"), deny.RouteNotAllowed},
		{"A5 root path", "PUT", archiveHelper("path=%2F&noOverwriteDirNonDir=true"), deny.RouteNotAllowed},
		{"A5 subpath", "PUT", archiveHelper("path=%2Fdata%2Fhermes%2Fx&noOverwriteDirNonDir=true"), deny.RouteNotAllowed},
		{"A5 trailing slash path", "PUT", archiveHelper("path=%2Fdata%2Fhermes%2F&noOverwriteDirNonDir=true"), deny.RouteNotAllowed},
		{"A5 decoded path", "PUT", archiveHelper("path=/data/hermes&noOverwriteDirNonDir=true"), deny.RouteNotAllowed},
		{"A5 lowercase escape", "PUT", archiveHelper("path=%2fdata%2fhermes&noOverwriteDirNonDir=true"), deny.RouteNotAllowed},
		{"A5 double escape", "PUT", archiveHelper("path=%252Fdata%252Fhermes&noOverwriteDirNonDir=true"), deny.RouteNotAllowed},
		{"A5 no flag", "PUT", archiveHelper("path=%2Fscratch"), deny.RouteNotAllowed},
		{"A5 flag false", "PUT", archiveHelper("path=%2Fscratch&noOverwriteDirNonDir=false"), deny.RouteNotAllowed},
		{"A5 flag first", "PUT", archiveHelper("noOverwriteDirNonDir=true&path=%2Fscratch"), deny.RouteNotAllowed},
		{"A5 copyUIDGID", "PUT", archiveHelper("path=%2Fscratch&noOverwriteDirNonDir=true&copyUIDGID=true"), deny.RouteNotAllowed},
		{"A5 empty path", "PUT", archiveHelper("path=&noOverwriteDirNonDir=true"), deny.RouteNotAllowed},

		// A6
		{"A6 next", "POST", c + nameANext + "/start", deny.RouteNotAllowed},
		{"A6 GET", "GET", c + nameA + "/start", deny.RouteNotAllowed},
		{"A6 query", "POST", c + nameA + "/start?detachKeys=x", deny.RouteNotAllowed},
		{"A6 empty query", "POST", c + nameA + "/start?", deny.RouteNotAllowed},
		{"A6 trailing slash", "POST", c + nameA + "/start/", deny.RouteNotAllowed},

		// A7 and A8
		{"A7 main", "POST", c + nameA + "/wait?condition=not-running", deny.RouteNotAllowed},
		{"A7 next", "POST", c + nameANext + "/wait?condition=not-running", deny.RouteNotAllowed},
		{"A7 other condition", "POST", c + nameAHelp + "/wait?condition=removed", deny.RouteNotAllowed},
		{"A7 no condition", "POST", c + nameAHelp + "/wait", deny.RouteNotAllowed},
		{"A7 GET", "GET", c + nameAHelp + "/wait?condition=not-running", deny.RouteNotAllowed},
		{"A7 extra query", "POST", c + nameAHelp + "/wait?condition=not-running&x=1", deny.RouteNotAllowed},
		{"A8 main", "GET", c + nameA + "/logs?stdout=true&stderr=true&tail=20", deny.RouteNotAllowed},
		{"A8 follow", "GET", c + nameAHelp + "/logs?stdout=true&stderr=true&tail=20&follow=true", deny.RouteNotAllowed},
		{"A8 tail all", "GET", c + nameAHelp + "/logs?stdout=true&stderr=true&tail=all", deny.RouteNotAllowed},
		{"A8 tail 21", "GET", c + nameAHelp + "/logs?stdout=true&stderr=true&tail=21", deny.RouteNotAllowed},
		{"A8 reordered", "GET", c + nameAHelp + "/logs?stderr=true&stdout=true&tail=20", deny.RouteNotAllowed},
		{"A8 duplicate", "GET", c + nameAHelp + "/logs?stdout=true&stdout=true&stderr=true&tail=20", deny.RouteNotAllowed},
		{"A8 POST", "POST", c + nameAHelp + "/logs?stdout=true&stderr=true&tail=20", deny.RouteNotAllowed},

		// A9
		{"A9 no query", "DELETE", c + nameA, deny.RouteNotAllowed},
		{"A9 force only", "DELETE", c + nameA + "?force=true", deny.RouteNotAllowed},
		{"A9 v only", "DELETE", c + nameA + "?v=true", deny.RouteNotAllowed},
		{"A9 reordered", "DELETE", c + nameA + "?v=true&force=true", deny.RouteNotAllowed},
		{"A9 force false", "DELETE", c + nameA + "?force=false&v=true", deny.RouteNotAllowed},
		{"A9 link", "DELETE", c + nameA + "?force=true&v=true&link=true", deny.RouteNotAllowed},
		{"A9 numeric", "DELETE", c + nameA + "?force=1&v=1", deny.RouteNotAllowed},
		{"A9 GET", "GET", c + nameA + "?force=true&v=true", deny.RouteNotAllowed},
		{"A9 POST", "POST", c + nameA + "?force=true&v=true", deny.RouteNotAllowed},
		{"A9 foreign name", "DELETE", c + "other?force=true&v=true", deny.RouteNotAllowed},
		{"A9 trailing slash", "DELETE", c + nameA + "/?force=true&v=true", deny.RouteNotAllowed},

		// A10 and A11
		{"A10 helper", "POST", c + nameAHelp + "/stop?t=30", deny.RouteNotAllowed},
		{"A10 next", "POST", c + nameANext + "/stop?t=30", deny.RouteNotAllowed},
		{"A10 no t", "POST", c + nameA + "/stop", deny.RouteNotAllowed},
		{"A10 t=0", "POST", c + nameA + "/stop?t=0", deny.RouteNotAllowed},
		{"A10 t=31", "POST", c + nameA + "/stop?t=31", deny.RouteNotAllowed},
		{"A10 duplicate t", "POST", c + nameA + "/stop?t=30&t=30", deny.RouteNotAllowed},
		{"A10 signal", "POST", c + nameA + "/stop?t=30&signal=SIGKILL", deny.RouteNotAllowed},
		{"A10 GET", "GET", c + nameA + "/stop?t=30", deny.RouteNotAllowed},
		{"A11 helper", "POST", c + nameAHelp + "/restart?t=30", deny.RouteNotAllowed},
		{"A11 next", "POST", c + nameANext + "/restart?t=30", deny.RouteNotAllowed},
		{"A11 no t", "POST", c + nameA + "/restart", deny.RouteNotAllowed},
		{"A11 t=0", "POST", c + nameA + "/restart?t=0", deny.RouteNotAllowed},
		{"A11 signal", "POST", c + nameA + "/restart?t=30&signal=SIGKILL", deny.RouteNotAllowed},

		// A12
		{"A12 GET", "GET", c + nameANext + "/rename?name=" + nameA, deny.RouteNotAllowed},
		{"A12 from main", "POST", c + nameA + "/rename?name=" + nameA, deny.RouteNotAllowed},
		{"A12 from helper", "POST", c + nameAHelp + "/rename?name=" + nameA, deny.RouteNotAllowed},
		{"A12 to other bot", "POST", c + nameANext + "/rename?name=" + nameB, deny.RouteNotAllowed},
		{"A12 to next", "POST", c + nameANext + "/rename?name=" + nameANext, deny.RouteNotAllowed},
		{"A12 to helper", "POST", c + nameANext + "/rename?name=" + nameAHelp, deny.RouteNotAllowed},
		{"A12 to foreign", "POST", c + nameANext + "/rename?name=other", deny.RouteNotAllowed},
		{"A12 no name", "POST", c + nameANext + "/rename", deny.RouteNotAllowed},
		{"A12 extra query", "POST", c + nameANext + "/rename?name=" + nameA + "&x=1", deny.RouteNotAllowed},
		{"A12 other bot from", "POST", c + nameB + ".next/rename?name=" + nameA, deny.RouteNotAllowed},

		// raw-target vectors: no decoding, no normalisation
		{"encoded letter in name", "GET", c + "%6Dyrmidon-bot-" + keyA + "/json", deny.RouteNotAllowed},
		{"encoded dash in name", "GET", c + "myrmidon%2Dbot-" + keyA + "/json", deny.RouteNotAllowed},
		{"encoded slash after name", "GET", c + nameA + "%2Fjson", deny.RouteNotAllowed},
		{"encoded slash lowercase", "GET", c + nameA + "%2fjson", deny.RouteNotAllowed},
		{"encoded dot segment", "GET", c + nameA + "/%2e%2e/json", deny.RouteNotAllowed},
		{"uppercase key", "GET", c + NamePrefix + strings.ToUpper(keyA) + "/json", deny.RouteNotAllowed},
		{"double slash after version", "GET", "/v1.45//containers/" + nameA + "/json", deny.RouteNotAllowed},
		{"double slash before name", "GET", c + "/" + nameA + "/json", deny.RouteNotAllowed},
		{"double slash before tail", "GET", c + nameA + "//json", deny.RouteNotAllowed},
		{"dot segment", "GET", v + "containers/./" + nameA + "/json", deny.RouteNotAllowed},
		{"dot dot segment", "GET", v + "images/../containers/" + nameA + "/json", deny.RouteNotAllowed},
		{"traversal to another api", "GET", c + nameA + "/../../../info", deny.RouteNotAllowed},
		{"semicolon", "GET", c + nameA + "/json;x=1", deny.RouteNotAllowed},
		{"fragment", "GET", c + nameA + "/json#x", deny.RouteNotAllowed},
		{"trailing slash", "GET", c + nameA + "/json/", deny.RouteNotAllowed},
		{"container without tail", "GET", c + nameA, deny.RouteNotAllowed},
		{"container with only slash", "GET", c + nameA + "/", deny.RouteNotAllowed},
		{"space in target", "GET", c + nameA + "/json ", deny.RouteNotAllowed},
		{"backslash", "GET", c + nameA + "\\json", deny.RouteNotAllowed},
		{"null byte escape", "GET", c + nameA + "/json%00", deny.RouteNotAllowed},
		{"name prefix only", "GET", c + NamePrefix + "/json", deny.RouteNotAllowed},
		{"key with braces", "GET", c + NamePrefix + "{" + keyA + "}/json", deny.RouteNotAllowed},
		{"container id instead of name", "GET", c + strings.Repeat("ab", 32) + "/json", deny.RouteNotAllowed},
		{"other prefix", "GET", c + "xmyrmidon-bot-" + keyA + "/json", deny.RouteNotAllowed},
		{"suffix without dot", "GET", c + nameA + "next/json", deny.RouteNotAllowed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Parse(tc.method, tc.target, images())
			if err == nil {
				t.Fatalf("%s %s accepted as %+v", tc.method, tc.target, *got)
			}
			if err.Code != tc.code {
				t.Fatalf("%s %s: %s, want %s", tc.method, tc.target, err.Code, tc.code)
			}
			if err.Status != 400 && err.Status != 403 {
				t.Fatalf("status %d", err.Status)
			}
		})
	}
}

// The closed list of the specification: every route that the daemon has and
// dockergate does not forward, under every method.
func TestClosedList(t *testing.T) {
	const v = "/v1.45/"
	c := v + "containers/" + nameA
	paths := []string{
		v + "containers/json",
		v + "containers/json?all=true",
		v + "containers/prune",
		v + "containers/prune?filters=%7B%7D",
		c + "/exec", c + "/attach", c + "/attach/ws", c + "/commit", c + "/export",
		c + "/changes", c + "/top", c + "/stats", c + "/kill", c + "/pause",
		c + "/unpause", c + "/update", c + "/resize", c + "/kill?signal=SIGKILL",
		c + "/logs", c + "/archive", c + "/archive?path=%2F",
		v + "containers/" + nameAHelp + "/exec", v + "containers/" + nameAHelp + "/attach",
		v + "exec/abc/start", v + "exec/abc/json", v + "exec/abc/resize",
		v + "images/create?fromImage=x", v + "images/create",
		v + "images/" + NameSegment(ref1), v + "images/" + NameSegment(ref1) + "/push",
		v + "images/" + NameSegment(ref1) + "/tag", v + "images/" + NameSegment(ref1) + "/history",
		v + "images/" + NameSegment(ref1) + "/get", v + "images/x/json",
		v + "images/json", v + "images/search?term=x", v + "images/prune", v + "images/get",
		v + "images/load",
		v + "build", v + "build?t=x", v + "build/prune", v + "commit?container=x",
		v + "volumes", v + "volumes/create", v + "volumes/x", v + "volumes/prune",
		v + "networks", v + "networks/create", v + "networks/x", v + "networks/x/connect",
		v + "networks/x/disconnect", v + "networks/prune",
		v + "plugins", v + "plugins/x", v + "plugins/pull",
		v + "swarm", v + "swarm/init", v + "services", v + "services/create",
		v + "nodes", v + "tasks", v + "secrets", v + "configs",
		v + "system/df", v + "info", v + "version", v + "_ping", v + "events", v + "session",
		v + "distribution/x/json", v + "auth",
	}
	for _, p := range paths {
		for _, m := range []string{"GET", "POST", "PUT", "DELETE"} {
			got, err := Parse(m, p, images())
			if err == nil {
				// The allow list is allowed to contain a path only in its own
				// method; none of these paths is in the list.
				t.Errorf("%s %s accepted as %+v", m, p, *got)
				continue
			}
			if err.Code != deny.RouteNotAllowed {
				t.Errorf("%s %s: %s", m, p, err.Code)
			}
		}
	}
}

func TestNameSegmentMatchesEncodeURIComponent(t *testing.T) {
	cases := map[string]string{
		"plain":                 "plain",
		"a b":                   "a%20b",
		"a@b:c":                 "a%40b%3Ac",
		"repo/name@sha256:abc":  "repo/name%40sha256%3Aabc",
		"-_.!~*'()":             "-_.!~*'()",
		"a+b=c&d?e#f%g":         "a%2Bb%3Dc%26d%3Fe%23f%25g",
		"ü":                     "%C3%BC",
		"a,b;c$d":               "a%2Cb%3Bc%24d",
		"[x]{y}":                "%5Bx%5D%7By%7D",
		"a/b/c":                 "a/b/c",
		"host:5000/a/b:tag":     "host%3A5000/a/b%3Atag",
		"ghcr.io/o/r@sha256:00": "ghcr.io/o/r%40sha256%3A00",
	}
	for in, want := range cases {
		if got := NameSegment(in); got != want {
			t.Errorf("NameSegment(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsBotKey(t *testing.T) {
	good := []string{keyA, keyB, "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"}
	for _, k := range good {
		if !IsBotKey(k) {
			t.Errorf("%q refused", k)
		}
	}
	bad := []string{
		"", "x", strings.ToUpper(keyA), keyA[:35], keyA + "0", "0a1b2c3d_1111-2222-3333-444455556666",
		"0a1b2c3d-1111-2222-3333-44445555666g", "0a1b2c3d11112222333344445555666677", " " + keyA[1:],
		"{" + keyA[1:35] + "}", "0a1b2c3d-1111-2222-3333-4444555566%6",
	}
	for _, k := range bad {
		if IsBotKey(k) {
			t.Errorf("%q accepted", k)
		}
	}
}

func TestNameOf(t *testing.T) {
	if NameOf(keyA, SuffixMain) != nameA || NameOf(keyA, SuffixNext) != nameANext || NameOf(keyA, SuffixHelper) != nameAHelp {
		t.Fatal("NameOf")
	}
}

func TestNewImagesKeys(t *testing.T) {
	m := NewImages([]string{ref1})
	want := "images/" + NameSegment(ref1) + "/json"
	if got, ok := m[want]; !ok || got != ref1 || len(m) != 1 {
		t.Fatalf("images: %v", m)
	}
}

func TestEmptyImagesAllowsNoA1(t *testing.T) {
	_, err := Parse("GET", "/v1.45/images/"+NameSegment(ref1)+"/json", NewImages(nil))
	if err == nil || err.Code != deny.RouteNotAllowed {
		t.Fatalf("A1 with no images: %v", err)
	}
}
