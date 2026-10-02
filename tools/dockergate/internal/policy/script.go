package policy

import (
	"regexp"
	"strings"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

var nonceRe = regexp.MustCompile(`^[0-9a-f]{16}$`)

// ApplyScript is Cmd[0] of the apply helper for a nonce.
func ApplyScript(nonce string) string {
	return strings.ReplaceAll(applyTemplate, NoncePlaceholder, nonce)
}

// IsNonce reports whether s is a nonce as the board generates it: 16 lowercase
// hex characters.
func IsNonce(s string) bool { return nonceRe.MatchString(s) }

// ExtractNonce reads N from the "n=<N>" line of an apply script and verifies
// that the whole script is the reference script for that N, byte for byte.
// A script without the line is script_mismatch, a line with a malformed nonce
// is nonce_invalid.
func ExtractNonce(script string) (string, *deny.Error) {
	const marker = "\nn="
	i := strings.Index(script, marker)
	if i < 0 {
		return "", deny.New(deny.ScriptMismatch).WithDetail("no_nonce_line")
	}
	rest := script[i+len(marker):]
	end := strings.IndexByte(rest, '\n')
	if end < 0 {
		end = len(rest)
	}
	nonce := rest[:end]
	if !IsNonce(nonce) {
		return "", deny.New(deny.NonceInvalid)
	}
	if script != ApplyScript(nonce) {
		return "", deny.New(deny.ScriptMismatch).WithDetail("apply")
	}
	return nonce, nil
}
