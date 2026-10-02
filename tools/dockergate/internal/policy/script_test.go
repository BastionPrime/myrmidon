package policy_test

import (
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fixture"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
)

// The Go scripts are the scripts of the driver, for every recorded nonce.
func TestScriptsEqualTheDriversScripts(t *testing.T) {
	m := fixture.Load(t)
	if policy.PrepareScript != fixture.Script(t, "prepare") {
		t.Fatal("PrepareScript differs from the driver's script")
	}
	if len(m.Nonces) < 5 {
		t.Fatalf("only %d nonces recorded", len(m.Nonces))
	}
	for _, n := range m.Nonces {
		want := fixture.Script(t, "apply-"+n)
		if got := policy.ApplyScript(n); got != want {
			t.Errorf("ApplyScript(%s) differs from the driver's script", n)
		}
		if c := strings.Count(want, n); c != 5 {
			t.Errorf("the nonce %s stands in %d places, want 5", n, c)
		}
		if got, err := policy.ExtractNonce(want); err != nil || got != n {
			t.Errorf("ExtractNonce(%s) = %q, %v", n, got, err)
		}
	}
}

// RT1_2: what the root helper runs is a constant text with no recursion, no
// link-following option, no find, no glob and no substitution.
func TestRedTeam_RT1_2_PrepareScriptStatic(t *testing.T) {
	s := policy.PrepareScript
	for _, bad := range []string{
		" -R", "-R ", "--recursive", " -L", " -H", " -h ", "find", "xargs", "*", "?", "[", "]",
		"$(", "`", "|", "&", ">", "<", "eval", "source", "exec", "sudo", "${", "~", "\\",
		"..", "-f", "--",
	} {
		if strings.Contains(s, bad) {
			t.Errorf("the prepare script contains %q", bad)
		}
	}
	if strings.Count(s, "chmod") != 1 || strings.Count(s, "chown") != 1 {
		t.Errorf("want exactly one chmod and one chown")
	}
	if !strings.Contains(s, "for d in data/hermes workspace scratch; do") {
		t.Errorf("the three mount points are not the fixed list")
	}
	if strings.Count(s, "\n") != 5 {
		t.Errorf("unexpected shape: %d lines", strings.Count(s, "\n")+1)
	}
	// It does not depend on the nonce or on anything the board sends.
	if strings.Contains(s, policy.NoncePlaceholder) {
		t.Errorf("a placeholder in the prepare script")
	}
}

func TestExtractNonce(t *testing.T) {
	n := "0123456789abcdef"
	good := policy.ApplyScript(n)
	cases := []struct {
		name   string
		script string
		code   string
	}{
		{"empty", "", deny.ScriptMismatch},
		{"prepare script", policy.PrepareScript, deny.ScriptMismatch},
		{"no nonce line", strings.Replace(good, "\nn="+n+"\n", "\nm="+n+"\n", 1), deny.ScriptMismatch},
		{"uppercase nonce", strings.Replace(good, "n="+n, "n="+strings.ToUpper(n), 1), deny.NonceInvalid},
		{"short nonce", strings.Replace(good, "n="+n, "n="+n[:15], 1), deny.NonceInvalid},
		{"nonce with a space", strings.Replace(good, "n="+n, "n="+n+" x", 1), deny.NonceInvalid},
		{"changed body", strings.Replace(good, "umask 077", "umask 000", 1), deny.ScriptMismatch},
		{"appended", good + "\nid", deny.ScriptMismatch},
		{"one nonce place differs", strings.Replace(good, ".myrmidon-apply-"+n+"/staged.list", ".myrmidon-apply-0000000000000000/staged.list", 1), deny.ScriptMismatch},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := policy.ExtractNonce(tc.script)
			if err == nil {
				t.Fatalf("accepted nonce %q", got)
			}
			if err.Code != tc.code {
				t.Fatalf("denied as %s, want %s", err.Code, tc.code)
			}
		})
	}
	if got, err := policy.ExtractNonce(good); err != nil || got != n {
		t.Fatalf("the reference script: %q, %v", got, err)
	}
}

func TestIsNonceAndIsImageID(t *testing.T) {
	for _, s := range []string{"0123456789abcdef", "0000000000000000", "ffffffffffffffff"} {
		if !policy.IsNonce(s) {
			t.Errorf("nonce %q refused", s)
		}
	}
	for _, s := range []string{"", "0123456789abcde", "0123456789abcdef0", "0123456789ABCDEF", "0123456789abcdeg", " 0123456789abcde", "0123456789abcdef\n"} {
		if policy.IsNonce(s) {
			t.Errorf("nonce %q accepted", s)
		}
	}
	id := "sha256:" + strings.Repeat("ab", 32)
	if !policy.IsImageID(id) {
		t.Errorf("id refused")
	}
	for _, s := range []string{"", id + "0", id[:len(id)-1], strings.ToUpper(id), "sha256:" + strings.Repeat("g", 64), strings.Repeat("ab", 32), id + "\n", "sha512:" + strings.Repeat("ab", 32)} {
		if policy.IsImageID(s) {
			t.Errorf("id %q accepted", s)
		}
	}
}
