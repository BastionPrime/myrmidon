package ustar_test

import (
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fixture"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/ustar"
)

// The contract of the applied marker (RELEASE-GATE, the 01.10 incident): every
// marker serializeAppliedMarker() (server) writes must pass the dockergate
// validator. The fixtures under markers/ are generated from the server code of
// THIS commit by contract/emit-marker-contract.mjs — never hand-copied — and
// CI points DOCKERGATE_CONTRACT_DIR at the freshly emitted set, so the test
// proves the two halves of the same release agree on the marker shape. When a
// marker change in the server is not mirrored by the validator, this test
// fails red before any image is built.
func TestContract_AppliedMarkersFromTheServer(t *testing.T) {
	mc := fixture.MarkerContractAll(t)
	seen := map[string]bool{}
	for _, m := range mc.Index {
		m := m
		t.Run(m.ID, func(t *testing.T) {
			if seen[m.ID] {
				t.Fatalf("duplicate marker id %q", m.ID)
			}
			seen[m.ID] = true
			// The marker keeps the exact bytes the server writes (including
			// the trailing newline): the validator must accept the real bytes,
			// not a normalized copy.
			marker := fixture.MarkerBytes(t, m)
			entries := replaceApplied(hermesEntries(nonce), marker)
			archive := build(t, entries)
			wantOK(t, archive, hermes, nonce)
		})
	}
	// The matrix must cover both marker shapes: with and without the run limit.
	// If the emitter ever stops producing one of them, the contract silently
	// shrinks and a future mismatch ships — refuse that here.
	withLimit, withoutLimit := 0, 0
	for _, m := range mc.Index {
		if m.HasLimit {
			withLimit++
		} else {
			withoutLimit++
		}
	}
	if withLimit == 0 || withoutLimit == 0 {
		t.Fatalf("marker matrix must cover both shapes: %d with the limit, %d without", withLimit, withoutLimit)
	}
}

// The negative anchor of the contract: a marker the server does not produce
// must stay denied. This is the guard against the contract decaying into
// "accept anything" — the incident fix (#228) widened the shape, but only to
// the exact marker the server writes, and this test keeps that boundary.
func TestContract_AppliedMarkersRefuseForeignShapes(t *testing.T) {
	cases := []string{
		`{"restartHash":"r","filesHash":"f","files":[],"maxConcurrentRuns":3,"extra":1}`,
		`{"restartHash":"r","filesHash":"f","files":[],"maxConcurrentRuns":0}`,
		`{"restartHash":"r","filesHash":"f","files":[],"maxConcurrentRuns":"3"}`,
	}
	for _, body := range cases {
		entries := replaceApplied(hermesEntries(nonce), []byte(body+"\n"))
		res, err := ustar.Validate(build(t, entries), hermes, nonce)
		wantCode(t, res, err, "tar_content")
	}
}

// replaceApplied swaps the applied.json content of a hermes entry list with
// the given marker bytes, keeping the entry otherwise as the writer builds it.
func replaceApplied(entries []ustar.Entry, marker []byte) []ustar.Entry {
	const target = ".myrmidon-apply-" + nonce + "/applied.json"
	out := make([]ustar.Entry, 0, len(entries))
	replaced := false
	for _, e := range entries {
		if !e.Dir && e.Path == target {
			e.Data = append([]byte(nil), marker...)
			e.MTime = mtime
			replaced = true
		}
		out = append(out, e)
	}
	if !replaced {
		panic("no applied.json entry in the hermes fixture")
	}
	return out
}
