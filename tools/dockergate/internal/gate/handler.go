package gate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/upstream"
)

// reqState is one request on its way through the gate. Nothing of the client's
// request is copied to the daemon: the daemon gets what the routes below build.
type reqState struct {
	g     *Gate
	w     http.ResponseWriter
	r     *http.Request
	info  *connInfo
	start time.Time

	route     string
	key       string
	target    string
	targetID  string
	upstream  int
	reqBytes  int64
	respBytes int64
	derr      *deny.Error
	bodyDone  bool
}

// answer is a response that dockergate sends to the client.
type answer struct {
	status int
	ctype  string
	body   []byte
}

// ServeHTTP handles one request. The connection is already authenticated
// (listener.Accept); the pin is checked again here for every request.
func (g *Gate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rs := &reqState{g: g, w: w, r: r, start: g.now(), route: "none"}
	rs.info, _ = r.Context().Value(connKey{}).(*connInfo)
	defer rs.finish()
	if derr := rs.handle(); derr != nil {
		rs.derr = derr
		rs.writeDeny(derr)
	}
}

func headerPresent(h http.Header, name string) bool {
	_, ok := h[http.CanonicalHeaderKey(name)]
	return ok
}

func connectionHasUpgrade(h http.Header) bool {
	for _, v := range h["Connection"] {
		for _, tok := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(tok), "upgrade") {
				return true
			}
		}
	}
	return false
}

// checkHeaders refuses the framing and upgrade tricks (spec 5.3).
func checkHeaders(r *http.Request) *deny.Error {
	if len(r.TransferEncoding) > 0 || headerPresent(r.Header, "Transfer-Encoding") {
		return deny.New(deny.HeaderForbidden).WithStatus(http.StatusBadRequest).WithDetail("transfer-encoding")
	}
	if headerPresent(r.Header, "Upgrade") {
		return deny.New(deny.HeaderForbidden).WithDetail("upgrade")
	}
	if connectionHasUpgrade(r.Header) {
		return deny.New(deny.HeaderForbidden).WithDetail("connection-upgrade")
	}
	if headerPresent(r.Header, "Expect") {
		return deny.New(deny.HeaderForbidden).WithDetail("expect")
	}
	return nil
}

func hasBody(id string) bool { return id == route.A4 || id == route.A5 }

func (rs *reqState) handle() *deny.Error {
	g, r := rs.g, rs.r
	if rs.info == nil {
		return deny.New(deny.CallerNotBoardMain)
	}
	if !g.auth.Valid(rs.info.pin) {
		return deny.New(deny.CallerPinStale)
	}
	if !g.global.Allow(g.now()) {
		return deny.New(deny.RateLimited).WithDetail("global")
	}
	if r.ProtoMajor != 1 || r.ProtoMinor != 1 {
		return deny.New(deny.TargetForm).WithDetail("http_version")
	}
	if derr := checkHeaders(r); derr != nil {
		return derr
	}

	st := g.st.Load()
	rt, derr := route.Parse(r.Method, r.RequestURI, st.images)
	if derr != nil {
		return derr.At("target", []byte(r.RequestURI))
	}
	rs.route = rt.ID
	rs.key = rt.BotKey
	if rt.ID == route.A1 {
		rs.target = rt.ImageRef
	} else {
		rs.target = rt.Name
	}

	var (
		bot config.Bot
		bs  *botState
	)
	if rt.BotKey != "" {
		b, ok := st.cfg.Bot(rt.BotKey)
		if !ok {
			return deny.New(deny.BotNotEnrolled)
		}
		bot = b
		bs = g.bot(rt.BotKey, st.cfg.Limits)
	}
	if !hasBody(rt.ID) && r.ContentLength != 0 {
		return deny.New(deny.BodyNotAllowed)
	}

	release, ok := g.acquire()
	if !ok {
		return deny.New(deny.ConcurrencyLimited)
	}
	defer release()

	ctx := r.Context()
	switch rt.ID {
	case route.A1:
		return rs.a1(ctx, st, rt)
	case route.A2:
		return rs.a2(ctx, st, rt, bs)
	case route.A3:
		return rs.a3(ctx, st, rt, bs)
	case route.A4:
		return rs.a4(ctx, st, rt, bot, bs)
	case route.A5:
		return rs.a5(ctx, st, rt, bs)
	case route.A6:
		return rs.a6(ctx, st, rt, bs)
	case route.A7:
		return rs.a7(ctx, st, rt)
	case route.A8:
		return rs.a8(ctx, st, rt, bs)
	case route.A9:
		return rs.a9(ctx, st, rt, bs)
	case route.A10:
		return rs.a10(ctx, st, rt, bs)
	case route.A11:
		return rs.a11(ctx, st, rt, bs)
	case route.A12:
		return rs.a12(ctx, st, rt, bs)
	}
	return deny.New(deny.RouteNotAllowed)
}

// --- answers ------------------------------------------------------------------

// closeCodes are the denials after which the connection is closed: the framing
// of the request is in doubt or its caller is no longer the pinned one.
var closeCodes = map[string]bool{
	deny.HeaderForbidden: true,
	deny.BodyNotAllowed:  true,
	deny.TargetForm:      true,
	deny.ContentType:     true,
	deny.CallerPinStale:  true,
	deny.BodyTooLarge:    true,
	deny.TarTooLarge:     true,
}

func (rs *reqState) writeDeny(e *deny.Error) {
	body := deny.Message(e.Code)
	h := rs.w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	if closeCodes[e.Code] || (!rs.bodyDone && rs.r.ContentLength != 0) {
		h.Set("Connection", "close")
	}
	rs.w.WriteHeader(e.Status)
	n, _ := io.WriteString(rs.w, body)
	rs.respBytes = int64(n)
}

// safeContentType is the Content-Type of a daemon answer that is passed on;
// anything else is left out.
func safeContentType(ct string) string {
	switch ct {
	case "application/json", "application/x-tar", "application/vnd.docker.raw-stream",
		"application/vnd.docker.multiplexed-stream", "text/plain", "text/plain; charset=utf-8":
		return ct
	}
	return ""
}

func (rs *reqState) respond(a *answer) {
	h := rs.w.Header()
	if a.ctype != "" {
		h.Set("Content-Type", a.ctype)
	}
	noBody := a.status == http.StatusNoContent || a.status == http.StatusNotModified || a.status < 200
	if !noBody {
		h.Set("Content-Length", strconv.Itoa(len(a.body)))
	}
	rs.w.WriteHeader(a.status)
	if !noBody && len(a.body) > 0 {
		n, _ := rs.w.Write(a.body)
		rs.respBytes = int64(n)
	}
}

const jsonType = "application/json"

// notFound is the answer for a container that does not exist.
func (rs *reqState) notFound() *deny.Error {
	rs.upstream = http.StatusNotFound
	rs.respond(&answer{status: http.StatusNotFound, ctype: jsonType, body: []byte(`{"message":"No such container"}`)})
	return nil
}

// levelFor is the level of the log line of a denial.
func levelFor(code string) string {
	switch code {
	case deny.UpstreamError, deny.UpstreamTimeout, deny.UpstreamUpgrade, deny.ResponseTooLarge:
		return LevelError
	}
	return LevelWarn
}

func (g *Gate) peerInfo(info *connInfo) *PeerInfo {
	p := &PeerInfo{Pid: info.cred.PID, Uid: info.cred.UID, Gid: info.cred.GID}
	if info.pin != nil && info.pin.PID == info.cred.PID {
		p.Comm = info.pin.Comm
	}
	return p
}

// finish writes the log line and the counters of a request: exactly one line,
// made of fixed fields.
func (rs *reqState) finish() {
	g := rs.g
	dur := g.now().Sub(rs.start)
	line := Line{
		Route: rs.route, BotKey: rs.key, Target: rs.target, TargetID: rs.targetID,
		UpstreamStatus: rs.upstream, ReqBytes: rs.reqBytes, RespBytes: rs.respBytes, Ms: dur.Milliseconds(),
	}
	if rs.info != nil {
		line.Conn = rs.info.id
		line.Peer = g.peerInfo(rs.info)
	}
	reason := ""
	if e := rs.derr; e != nil {
		reason = e.Code
		line.Decision = "deny"
		line.Reason = e.Code
		line.Level = levelFor(e.Code)
		line.Field, line.FieldLen, line.FieldHash, line.Detail = e.Field, e.Len, e.Hash, e.Detail
	} else {
		line.Decision = "allow"
		line.Level = LevelInfo
	}
	g.log.Write(line)
	g.stats.record(rs.route, reason, dur, rs.upstream >= 500)
}

// abort ends a response that has already begun, without a clean end: the
// client sees a broken stream, not a short valid one.
func (rs *reqState) abort(e *deny.Error) {
	rs.derr = e
	panic(http.ErrAbortHandler)
}

// --- reading the body ----------------------------------------------------------

// readBody checks the Content-Type and reads the body of a route that has one.
func (rs *reqState) readBody(max int, ctype, syntaxCode string) ([]byte, *deny.Error) {
	r := rs.r
	if cts := r.Header["Content-Type"]; len(cts) != 1 || cts[0] != ctype {
		return nil, deny.New(deny.ContentType)
	}
	if r.ContentLength > int64(max) {
		return nil, deny.New(deny.BodyTooLarge)
	}
	timeout := config.Sec(rs.g.st.Load().cfg.Limits.BodyReadTimeoutSec)
	rc := http.NewResponseController(rs.w)
	_ = rc.SetReadDeadline(time.Now().Add(timeout))
	data, tooLarge, err := upstream.ReadLimited(r.Body, max)
	_ = rc.SetReadDeadline(time.Time{})
	if tooLarge {
		return nil, deny.New(deny.BodyTooLarge)
	}
	if err != nil {
		return nil, deny.New(syntaxCode).WithDetail("body_read")
	}
	rs.bodyDone = true
	rs.reqBytes = int64(len(data))
	return data, nil
}

// --- calls to the daemon ---------------------------------------------------------

func isID(s string) bool { return idRe.MatchString(s) }

// containerPath is the path of a container that dockergate addresses by the Id
// from its own inspect.
func containerPath(id, tail string) string {
	return upstream.Prefix + "/containers/" + id + tail
}

func (rs *reqState) timeouts() (def, stop, wait time.Duration) {
	l := rs.g.st.Load().cfg.Limits
	return config.Sec(l.UpstreamTimeoutSec), config.Sec(l.UpstreamStopSec), config.Sec(l.UpstreamWaitSec)
}

// call sends a request to the daemon and reads the answer. A success answer
// may be up to okMax bytes (over that: the code overflow); an error answer up
// to 64 KiB.
func (rs *reqState) call(ctx context.Context, req upstream.Request, timeout time.Duration, okMax int, overflow string) (*answer, *deny.Error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	res, derr := rs.g.up.Do(cctx, req)
	if derr != nil {
		return nil, derr
	}
	defer res.Body.Close()
	if res.Status < 200 || res.Status > 599 {
		return nil, deny.New(deny.UpstreamError).WithDetail("status")
	}
	success := res.Status < 300
	max := maxErrBody
	if success {
		max = okMax
	}
	data, tooLarge, err := upstream.ReadLimited(res.Body, max)
	if tooLarge {
		rs.upstream = res.Status
		if success {
			return nil, deny.New(overflow)
		}
		return nil, deny.New(deny.ResponseTooLarge)
	}
	if err != nil {
		if errors.Is(cctx.Err(), context.DeadlineExceeded) {
			return nil, deny.New(deny.UpstreamTimeout)
		}
		return nil, deny.New(deny.UpstreamError).WithDetail("read")
	}
	rs.upstream = res.Status
	return &answer{status: res.Status, ctype: safeContentType(res.Header.Get("Content-Type")), body: data}, nil
}

// inspectOurs inspects the container that carries the name of the bot and the
// role, and checks that it is ours: the name and the label of the role both
// say so (spec 9.1). (nil, nil) is a container that does not exist.
func (rs *reqState) inspectOurs(ctx context.Context, key string, sfx route.Suffix) (*upstream.Container, *deny.Error) {
	name := route.NameOf(key, sfx)
	ct, _, derr := rs.g.up.Inspect(ctx, name)
	if derr != nil {
		return nil, derr
	}
	if ct == nil {
		return nil, nil
	}
	if !isID(ct.ID) {
		return nil, deny.New(deny.UpstreamError).WithDetail("bad_id")
	}
	label := "myrmidon.bot"
	if sfx == route.SuffixHelper {
		label = "myrmidon.bot-helper"
	}
	if ct.Name != "/"+name || ct.Config.Labels[label] != key {
		return nil, deny.New(deny.ForeignContainer)
	}
	if name == rs.target {
		rs.targetID = ct.ID[:12]
	}
	return ct, nil
}
