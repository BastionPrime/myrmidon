// Package deny holds the reason codes of dockergate and the error type that
// carries a denial from the packages that decide (route, policy, ustar) to the
// one that answers (gate). A denial never carries a request value: only the
// path of the offending field, the length of its value and the first 12 hex
// characters of the value's sha256.
package deny

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
)

// Reason codes (spec appendix B).
const (
	CallerResolveFailed  = "caller_resolve_failed"
	CallerNotBoardMain   = "caller_not_board_main"
	CallerPinStale       = "caller_pin_stale"
	TargetForm           = "target_form"
	MethodNotAllowed     = "method_not_allowed"
	APIVersion           = "api_version"
	RouteNotAllowed      = "route_not_allowed"
	HeaderForbidden      = "header_forbidden"
	ContentType          = "content_type"
	BodyNotAllowed       = "body_not_allowed"
	BodyTooLarge         = "body_too_large"
	JSONSyntax           = "json_syntax"
	JSONDuplicateKey     = "json_duplicate_key"
	JSONUnknownKey       = "json_unknown_key"
	JSONType             = "json_type"
	JSONValue            = "json_value"
	JSONNotCanonical     = "json_not_canonical"
	BotNotEnrolled       = "bot_not_enrolled"
	ImageNotAllowed      = "image_not_allowed"
	ImageContract        = "image_contract"
	ImageUser            = "image_user"
	HelperImageMismatch  = "helper_image_mismatch"
	NameLabelMismatch    = "name_label_mismatch"
	BindsMismatch        = "binds_mismatch"
	NetworkMismatch      = "network_mismatch"
	LimitExceedsEnrolled = "limit_exceeds_enrollment"
	ScriptMismatch       = "script_mismatch"
	NonceInvalid         = "nonce_invalid"
	TarSyntax            = "tar_syntax"
	TarType              = "tar_type"
	TarOwner             = "tar_owner"
	TarMode              = "tar_mode"
	TarPath              = "tar_path"
	TarNonce             = "tar_nonce"
	TarOrder             = "tar_order"
	TarContent           = "tar_content"
	TarTooLarge          = "tar_too_large"
	TarNotCanonical      = "tar_not_canonical"
	ForeignContainer     = "foreign_container"
	StatePrecondition    = "state_precondition"
	VolumeRootInvariant  = "volume_root_invariant"
	RateLimited          = "rate_limited"
	ConcurrencyLimited   = "concurrency_limited"
	UpstreamError        = "upstream_error"
	UpstreamTimeout      = "upstream_timeout"
	UpstreamUpgrade      = "upstream_upgrade"
	ResponseTooLarge     = "response_too_large"
	MarkerTooLarge       = "marker_too_large"
)

// Error is a denial: an HTTP status, a reason code and, when the reason is a
// field of a body, where it was found.
type Error struct {
	Status int
	Code   string
	// Field is the path of the offending field ("HostConfig.Binds[1]"), empty
	// when the reason is not about a field.
	Field string
	// Len and Hash describe the offending value without repeating it.
	Len  int
	Hash string
	// Detail is a short fixed-vocabulary hint for the log, never a request value
	// (for example "volume.hermes" or "first_child_mismatch:argv").
	Detail string
}

func (e *Error) Error() string { return e.Code }

// StatusFor is the HTTP status dockergate answers with for a reason code.
func StatusFor(code string) int {
	switch code {
	case TargetForm, JSONSyntax, TarSyntax, ContentType, BodyNotAllowed:
		return http.StatusBadRequest
	case BodyTooLarge, TarTooLarge:
		return http.StatusRequestEntityTooLarge
	case RateLimited, ConcurrencyLimited:
		return http.StatusTooManyRequests
	case UpstreamError, UpstreamUpgrade, ResponseTooLarge:
		return http.StatusBadGateway
	case UpstreamTimeout:
		return http.StatusGatewayTimeout
	case MarkerTooLarge:
		return http.StatusNotFound
	default:
		return http.StatusForbidden
	}
}

// New returns a denial with the default status of the code.
func New(code string) *Error { return &Error{Status: StatusFor(code), Code: code} }

// WithStatus overrides the status.
func (e *Error) WithStatus(status int) *Error { e.Status = status; return e }

// WithDetail attaches a fixed-vocabulary hint.
func (e *Error) WithDetail(detail string) *Error { e.Detail = detail; return e }

// At records where a denial was found: the path of the field, the length of
// its value and a short hash of it. The value itself is not kept.
func (e *Error) At(field string, value []byte) *Error {
	e.Field = field
	e.Len = len(value)
	sum := sha256.Sum256(value)
	e.Hash = hex.EncodeToString(sum[:])[:12]
	return e
}

// Field returns a denial for a field of a body. The value itself is reduced to
// its length and a short hash.
func Field(code, field string, value []byte) *Error { return New(code).At(field, value) }

// FieldOnly returns a denial that names a field but has no single value to
// describe (a missing key, a wrong type).
func FieldOnly(code, field string) *Error {
	e := New(code)
	e.Field = field
	return e
}

// Message is the body of dockergate's own denial: Docker's error format, with
// the reason code and no value from the request.
func Message(code string) string {
	return `{"message":"dockergate: denied (` + code + `)"}`
}
