package gate_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fakedocker"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fixture"
)

// The contract between the board's template-drift check and the A2 answer.
//
// The board decides whether a bot container has drifted by comparing a freshly
// built create body with the fields it reads back from a container inspect;
// through dockergate that inspect is trimmed to a fixed field list. The field
// list and the daemon body both come from the driver's own code
// (contract/emit-fixtures.ts -> inspect-contract.json): every path the drift
// check reads must survive the trim, with the same value.
//
// A dropped field is not a smaller answer, it is a phantom drift: the board
// reads `undefined`, calls the container different and recreates it. That is
// the production incident of 01.10, where host HostConfig.Binds was trimmed
// away and all 51 bots were recreated every 17-20 minutes.
func TestContract_A2InspectCarriesEveryFieldTheDriftCheckReads(t *testing.T) {
	r := newRig(t)
	c := fixture.Inspect(t)
	if len(c.Fields) == 0 {
		t.Fatal("inspect-contract.json carries no fields")
	}
	raw := c.Inspect
	if len(raw) == 0 {
		t.Fatal("inspect-contract.json carries no inspect body")
	}

	// The daemon answers the inspect with exactly the recorded body. The trim
	// under test is dockergate's.
	r.d.SetHook(func(call fakedocker.Call) *fakedocker.Reply {
		if call.Method == http.MethodGet && call.Path() == "/v1.45/containers/"+url.PathEscape(c.Name)+"/json" {
			return &fakedocker.Reply{Status: http.StatusOK, Body: raw}
		}
		return nil
	})

	res := r.send(http.MethodGet, "/v1.45/containers/"+url.PathEscape(c.Name)+"/json", nil, nil)
	wantStatus(t, res, http.StatusOK)

	var got, source map[string]any
	if err := json.Unmarshal(res.Body, &got); err != nil {
		t.Fatalf("the A2 answer is not an object: %v (%q)", err, res.str())
	}
	if err := json.Unmarshal(raw, &source); err != nil {
		t.Fatalf("the fixture inspect is not an object: %v", err)
	}

	for _, f := range c.Fields {
		var want any
		if err := json.Unmarshal(f.Want, &want); err != nil {
			t.Fatalf("%s: want %s: %v", f.Path, f.Want, err)
		}
		// The fixture must be coherent: the daemon body carries the wanted
		// value, so a mismatch below is the trim's doing and nothing else.
		if v, ok := walk(source, f.Path); !ok || !sameJSON(v, want) {
			t.Fatalf("the fixture inspect does not carry %s = %s (got %v)", f.Path, f.Want, v)
		}
		v, ok := walk(got, f.Path)
		if !ok {
			t.Errorf("the A2 answer has no %s: the drift check reads it, so every bot would look drifted", f.Path)
			continue
		}
		if !sameJSON(v, want) {
			t.Errorf("%s is %v in the A2 answer, want %v", f.Path, v, want)
		}
	}

	// What the trim is for: the fields the driver does not read stay out.
	if _, ok := walk(got, "Mounts"); ok {
		t.Errorf("the A2 answer carries Mounts")
	}
	if cfg, _ := walk(got, "Config"); cfg != nil {
		if m, _ := cfg.(map[string]any); m != nil {
			if _, ok := m["Env"]; ok {
				t.Errorf("the A2 answer carries Config.Env")
			}
		}
	}
}

// walk resolves a dotted path inside a decoded JSON object.
func walk(v any, path string) (any, bool) {
	cur := v
	for _, seg := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[seg]; !ok {
			return nil, false
		}
	}
	return cur, true
}

// sameJSON compares two decoded JSON values structurally.
func sameJSON(a, b any) bool {
	ab, errA := json.Marshal(a)
	bb, errB := json.Marshal(b)
	return errA == nil && errB == nil && string(ab) == string(bb)
}
