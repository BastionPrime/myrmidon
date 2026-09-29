// Package upstream is the client of dockergate for the Docker daemon. It never
// forwards a client's request: every call is built here from checked values,
// with no header but Host, Content-Type and Content-Length, and always against
// API version 1.45.
package upstream

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// Prefix is the API version that dockergate speaks to the daemon.
const Prefix = "/v1.45"

// Request is one call to the daemon.
type Request struct {
	Method string
	// Target is the request-target, raw, starting with Prefix + "/". It is
	// written to the daemon as it is: nothing is decoded or re-encoded.
	Target      string
	Body        []byte
	ContentType string
}

// Resp is a response of the daemon. The caller closes Body.
type Resp struct {
	Status int
	Header http.Header
	Body   io.ReadCloser
}

// Client talks to the daemon over its unix socket.
type Client struct {
	socket string
	http   *http.Client
	tr     *http.Transport
}

// New returns a client for the daemon socket at path.
func New(socket string, idleConnTimeout time.Duration) *Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		DisableCompression:  true,
		MaxIdleConns:        16,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     idleConnTimeout,
		// One request at a time per connection is what net/http does; there is
		// no pipelining to the daemon.
		ForceAttemptHTTP2: false,
	}
	return &Client{socket: socket, tr: tr, http: &http.Client{
		Transport: tr,
		// A redirect from the daemon is not followed.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// Close drops the idle connections.
func (c *Client) Close() { c.tr.CloseIdleConnections() }

func newRequest(ctx context.Context, r Request) (*http.Request, error) {
	path, query, _ := strings.Cut(r.Target, "?")
	var body io.Reader
	if r.Body != nil {
		body = bytes.NewReader(r.Body)
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, "http://docker/", body)
	if err != nil {
		return nil, err
	}
	// Opaque makes net/http write the path exactly as given, without the
	// re-encoding that a parsed path would get; the query is written as given.
	req.URL = &url.URL{Scheme: "http", Host: "docker", Opaque: path, RawQuery: query}
	req.Host = "docker"
	req.Header = http.Header{}
	// An empty User-Agent value makes net/http leave the header out.
	req.Header["User-Agent"] = []string{""}
	if r.ContentType != "" {
		req.Header.Set("Content-Type", r.ContentType)
	}
	if r.Body != nil {
		req.ContentLength = int64(len(r.Body))
	}
	return req, nil
}

// Do sends a request. ctx carries the deadline of the call and the
// cancellation when the client of dockergate goes away.
func (c *Client) Do(ctx context.Context, r Request) (*Resp, *deny.Error) {
	req, err := newRequest(ctx, r)
	if err != nil {
		return nil, deny.New(deny.UpstreamError).WithDetail("request")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, transportError(ctx, err)
	}
	if res.StatusCode == http.StatusSwitchingProtocols {
		res.Body.Close()
		return nil, deny.New(deny.UpstreamUpgrade)
	}
	return &Resp{Status: res.StatusCode, Header: res.Header, Body: res.Body}, nil
}

func transportError(ctx context.Context, err error) *deny.Error {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return deny.New(deny.UpstreamTimeout)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return deny.New(deny.UpstreamTimeout)
	}
	if errors.Is(err, context.Canceled) {
		return deny.New(deny.UpstreamError).WithDetail("canceled")
	}
	return deny.New(deny.UpstreamError).WithDetail("transport")
}

// ReadLimited reads a body of at most max bytes. tooLarge is true when there is
// more.
func ReadLimited(r io.Reader, max int) (data []byte, tooLarge bool, err error) {
	data, err = io.ReadAll(io.LimitReader(r, int64(max)+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) > max {
		return nil, true, nil
	}
	return data, false, nil
}

// Fetch sends a request and reads the answer to the end, at most max bytes.
// The context of the call is cut after timeout.
func (c *Client) Fetch(ctx context.Context, r Request, timeout time.Duration, max int) (status int, body []byte, derr *deny.Error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	res, derr := c.Do(ctx, r)
	if derr != nil {
		return 0, nil, derr
	}
	defer res.Body.Close()
	data, tooLarge, err := ReadLimited(res.Body, max)
	if tooLarge {
		return res.Status, nil, deny.New(deny.ResponseTooLarge)
	}
	if err != nil {
		return 0, nil, transportError(ctx, err)
	}
	return res.Status, data, nil
}
