package gate

import (
	"encoding/json"
	"io"
	"sync"
	"time"
)

// Levels of a log line (spec 11.2).
const (
	LevelInfo  = "info"
	LevelWarn  = "warn"
	LevelError = "error"
)

// Line is one log line. Every field has a fixed meaning and none of them holds
// a body, the name of a tar entry, a query value outside the template or a
// client header, so a line cannot carry a secret by construction.
type Line struct {
	Ts    string `json:"ts"`
	Level string `json:"level"`
	// Event names a line that is not a decision: caller_decoy, reject_flood,
	// caller_resolve_failed, caller_not_board_main, config_reload_failed,
	// self-check ok, and so on.
	Event string `json:"event,omitempty"`

	Conn     uint64    `json:"conn,omitempty"`
	Peer     *PeerInfo `json:"peer,omitempty"`
	Route    string    `json:"route,omitempty"`
	BotKey   string    `json:"botKey,omitempty"`
	Target   string    `json:"target,omitempty"`
	TargetID string    `json:"targetId,omitempty"`
	Decision string    `json:"decision,omitempty"`
	Reason   string    `json:"reason,omitempty"`

	// Field, FieldLen and FieldHash describe the value that a denial is about.
	Field     string `json:"field,omitempty"`
	FieldLen  int    `json:"fieldLen,omitempty"`
	FieldHash string `json:"fieldHash,omitempty"`
	// Detail is a fixed-vocabulary hint.
	Detail string `json:"detail,omitempty"`

	UpstreamStatus int   `json:"upstreamStatus,omitempty"`
	ReqBytes       int64 `json:"reqBytes"`
	RespBytes      int64 `json:"respBytes"`
	Ms             int64 `json:"ms"`

	// Fields of the events.
	Count   uint64      `json:"count,omitempty"`
	Others  uint64      `json:"others,omitempty"`
	Callers []CallerRow `json:"callers,omitempty"`
	Pid     int         `json:"pid,omitempty"`
	Comm    string      `json:"comm,omitempty"`
	Diff    int64       `json:"startDiffTicks,omitempty"`
	Version string      `json:"version,omitempty"`
	Images  int         `json:"images,omitempty"`
	Pinned  *bool       `json:"pinned,omitempty"`
	API     string      `json:"apiVersion,omitempty"`
}

// PeerInfo is the caller of a connection.
type PeerInfo struct {
	Pid  int    `json:"pid"`
	Uid  uint32 `json:"uid"`
	Gid  uint32 `json:"gid"`
	Comm string `json:"comm,omitempty"`
}

// CallerRow is one row of the aggregated log of refused callers.
type CallerRow struct {
	Pid   int    `json:"pid"`
	Comm  string `json:"comm,omitempty"`
	Count uint64 `json:"count"`
}

// Logger writes one JSON object per line.
type Logger struct {
	mu  sync.Mutex
	w   io.Writer
	now func() time.Time
}

// NewLogger returns a logger that writes to w.
func NewLogger(w io.Writer, now func() time.Time) *Logger {
	if now == nil {
		now = time.Now
	}
	return &Logger{w: w, now: now}
}

// Write writes a line; the time is set here.
func (l *Logger) Write(line Line) {
	if l == nil || l.w == nil {
		return
	}
	line.Ts = l.now().UTC().Format(time.RFC3339Nano)
	if line.Level == "" {
		line.Level = LevelInfo
	}
	b, err := json.Marshal(line)
	if err != nil {
		return
	}
	b = append(b, '\n')
	l.mu.Lock()
	_, _ = l.w.Write(b)
	l.mu.Unlock()
}
