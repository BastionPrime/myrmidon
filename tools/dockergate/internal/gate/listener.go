package gate

import (
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/peer"
)

type connKey struct{}

// connInfo is what is known of an accepted connection.
type connInfo struct {
	id   uint64
	cred peer.Cred
	pin  *peer.Pin
}

// authConn is a connection that passed the check of the caller. Closing it
// gives its slot back.
type authConn struct {
	net.Conn
	info *connInfo
	g    *Gate
	once sync.Once
}

func (c *authConn) Close() error {
	c.once.Do(func() { c.g.conns.Add(-1) })
	return c.Conn.Close()
}

// listener authenticates the caller of every connection before a byte of it is
// read (spec 4.3): the pinned board gets a connection; a foreign caller gets
// the static answer or is closed silently; neither takes a slot.
type listener struct {
	g  *Gate
	ln net.Listener
}

func (l *listener) Addr() net.Addr { return l.ln.Addr() }
func (l *listener) Close() error   { return l.ln.Close() }

func (l *listener) Accept() (net.Conn, error) {
	g := l.g
	for {
		c, err := l.ln.Accept()
		if err != nil {
			return nil, err
		}
		d := g.auth.Admit(c)
		switch d.Verdict {
		case peer.Accept:
			max := int64(g.st.Load().cfg.Limits.MaxAuthenticatedConns)
			if g.conns.Add(1) > max {
				g.conns.Add(-1)
				g.replyStatic(c, deny.ConcurrencyLimited)
				continue
			}
			return &authConn{Conn: c, g: g, info: &connInfo{id: g.connSeq.Add(1), cred: d.Cred, pin: d.Pin}}, nil
		case peer.Reply:
			g.stats.addDenyPeer()
			g.replyStatic(c, d.Code)
		default:
			_ = c.Close()
		}
	}
}

// replyStatic writes the static answer and closes. It runs on its own
// goroutine, of which there are at most 32: when they are all busy, the
// connection is closed without an answer. The request is not read.
func (g *Gate) replyStatic(c net.Conn, code string) {
	select {
	case g.replySem <- struct{}{}:
	default:
		_ = c.Close()
		return
	}
	go func() {
		defer func() { <-g.replySem }()
		defer c.Close()
		status := deny.StatusFor(code)
		body := deny.Message(code)
		msg := "HTTP/1.1 " + strconv.Itoa(status) + " " + statusText(status) + "\r\n" +
			"Content-Type: application/json\r\n" +
			"Content-Length: " + strconv.Itoa(len(body)) + "\r\n" +
			"Connection: close\r\n\r\n" + body
		_ = c.SetWriteDeadline(time.Now().Add(time.Second))
		_, _ = c.Write([]byte(msg))
	}()
}

func statusText(status int) string {
	switch status {
	case 403:
		return "Forbidden"
	case 429:
		return "Too Many Requests"
	}
	return "Error"
}
