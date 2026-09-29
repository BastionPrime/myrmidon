package deny

import (
	"strings"
	"testing"
)

func TestStatusFor(t *testing.T) {
	cases := map[string]int{
		TargetForm: 400, JSONSyntax: 400, TarSyntax: 400, ContentType: 400, BodyNotAllowed: 400,
		BodyTooLarge: 413, TarTooLarge: 413,
		RateLimited: 429, ConcurrencyLimited: 429,
		UpstreamError: 502, UpstreamUpgrade: 502, ResponseTooLarge: 502,
		UpstreamTimeout: 504,
		MarkerTooLarge:  404,
		RouteNotAllowed: 403, CallerNotBoardMain: 403, CallerPinStale: 403, HeaderForbidden: 403,
		BotNotEnrolled: 403, ForeignContainer: 403, StatePrecondition: 403, VolumeRootInvariant: 403,
		JSONNotCanonical: 403, BindsMismatch: 403, MethodNotAllowed: 403, APIVersion: 403,
	}
	for code, want := range cases {
		if got := StatusFor(code); got != want {
			t.Errorf("StatusFor(%s) = %d, want %d", code, got, want)
		}
	}
}

func TestMessageHasNoRequestValue(t *testing.T) {
	e := Field(BindsMismatch, "HostConfig.Binds", []byte("/etc:/host"))
	msg := Message(e.Code)
	if msg != `{"message":"dockergate: denied (binds_mismatch)"}` {
		t.Fatalf("message: %s", msg)
	}
	if strings.Contains(msg, "/etc") {
		t.Fatal("the message repeats a request value")
	}
}

func TestAtKeepsOnlyLengthAndHash(t *testing.T) {
	e := Field(ImageNotAllowed, "Image", []byte("example.invalid/x@sha256:abc"))
	if e.Field != "Image" || e.Len != 28 || len(e.Hash) != 12 {
		t.Fatalf("field record: %+v", e)
	}
	if strings.Contains(e.Hash, "example") {
		t.Fatal("hash is not a hash")
	}
}

func TestWithStatusOverrides(t *testing.T) {
	e := New(HeaderForbidden)
	if e.Status != 403 {
		t.Fatalf("default: %d", e.Status)
	}
	if e.WithStatus(400).Status != 400 {
		t.Fatal("WithStatus")
	}
}
