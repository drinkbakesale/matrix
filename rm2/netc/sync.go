// Package netc connects the display core to Matrix: Sync is the pure,
// clock-injected protocol and freshness tracker; Transport is the real
// TLS/SSE client. The stale timer runs on the device, so a dead server or
// network can never leave a screen that still claims to be live.
package netc

import (
	"encoding/json"
	"fmt"

	"matrixrm2/ui"
)

const (
	StaleAfterMs = 6000
)

type envelope struct {
	Protocol  int             `json:"protocol"`
	Epoch     string          `json:"epoch"`
	Revision  int64           `json:"revision"`
	Snapshot  *ui.Snapshot    `json:"snapshot"`
	Session   *ui.Session     `json:"session"`
	SessionID string          `json:"session_id"`
	Draft     *ui.Draft       `json:"draft"`
	Selection *ui.Selection   `json:"selection"`
	View      *ui.View        `json:"view"`
	Raw       json.RawMessage `json:"-"`
}

// Sync applies server messages to the App and owns the connection status.
type Sync struct {
	App       *ui.App
	WallClock func() string // text for "last confirmed"

	epoch     string
	revision  int64
	haveSnap  bool
	status    string
	endpoint  string
	detail    string
	lastValid int64
	lastText  string
	fatal     bool
}

func NewSync(app *ui.App, wall func() string) *Sync {
	return &Sync{App: app, WallClock: wall, status: "starting"}
}

func (s *Sync) Status() string { return s.status }

func (s *Sync) set(status, detail string, now int64) {
	s.status, s.detail = status, detail
	c := ui.Conn{Status: status, Endpoint: s.endpoint, Detail: detail, LastConfirmed: s.lastText}
	s.App.Apply(ui.Event{Kind: "conn", Conn: &c}, now)
}

// Connecting: a new attempt started. Content stays; status is never "fresh"
// until an authoritative snapshot arrives on this connection.
func (s *Sync) Connecting(endpoint string, now int64) {
	s.endpoint = endpoint
	if s.fatal {
		return
	}
	s.haveSnap = false
	if s.status == "starting" || s.status == "connecting" {
		s.set("connecting", "", now)
	} else if s.status == "fresh" {
		s.set("stale", "reconnecting", now)
	} else {
		s.set(s.status, s.detail, now) // endpoint text may have changed
	}
}

// Closed: transport loss is shown immediately.
func (s *Sync) Closed(reason string, now int64) {
	s.haveSnap = false
	if s.fatal {
		return
	}
	s.set("disconnected", reason, now)
}

// Tick marks the screen stale when no valid message arrived for 6 seconds.
func (s *Sync) Tick(now int64) {
	if s.status == "fresh" && now-s.lastValid >= StaleAfterMs {
		s.set("stale", "no heartbeat", now)
	}
}

func (s *Sync) valid(now int64) {
	s.lastValid = now
	s.lastText = s.WallClock()
	if s.status != "fresh" {
		s.set("fresh", "", now)
	}
}

// Message applies one SSE message. resync=true asks the transport to drop the
// stream and fetch a new authoritative snapshot.
func (s *Sync) Message(typ string, data []byte, now int64) (resync bool, err error) {
	var e envelope
	if err := json.Unmarshal(data, &e); err != nil {
		return true, fmt.Errorf("unreadable %s message: %w", typ, err)
	}
	if e.Protocol != ui.ProtocolVersion {
		s.fatal = true
		s.set("error", fmt.Sprintf("Matrix speaks protocol %d; this client understands %d. Update the RM2 client.", e.Protocol, ui.ProtocolVersion), now)
		return false, fmt.Errorf("protocol %d not supported", e.Protocol)
	}
	s.fatal = false
	if typ == "snapshot" {
		if e.Snapshot == nil {
			return true, fmt.Errorf("snapshot message without snapshot")
		}
		if s.haveSnap && e.Epoch == s.epoch && e.Revision < s.revision {
			return false, nil // an older snapshot can never replace newer state
		}
		s.epoch, s.revision, s.haveSnap = e.Epoch, e.Revision, true
		s.App.Apply(ui.Event{Kind: "snapshot", Snap: e.Snapshot}, now)
		s.valid(now)
		return false, nil
	}
	if !s.haveSnap {
		return false, nil // nothing is trusted before the snapshot on this connection
	}
	counted := typ != "heartbeat" && typ != "progress"
	want := s.revision
	if counted {
		want++
	}
	if e.Epoch != s.epoch {
		s.haveSnap = false
		return true, nil // server restarted
	}
	if e.Revision != want {
		if e.Revision <= s.revision {
			return false, nil // duplicate or reordered old message: ignored
		}
		s.haveSnap = false
		return true, nil // gap: resync
	}
	s.revision = e.Revision
	switch typ {
	case "session":
		if e.Session == nil {
			return true, fmt.Errorf("session message without session")
		}
		s.App.Apply(ui.Event{Kind: "session", Session: e.Session}, now)
	case "draft":
		if e.Draft == nil {
			return true, fmt.Errorf("draft message without draft")
		}
		s.App.Apply(ui.Event{Kind: "draft", SessionID: e.SessionID, Draft: e.Draft}, now)
	case "selection":
		if e.Selection == nil {
			return true, fmt.Errorf("selection message without selection")
		}
		s.App.Apply(ui.Event{Kind: "selection", Selection: e.Selection}, now)
	case "view":
		if e.View == nil {
			return true, fmt.Errorf("view message without view")
		}
		s.App.Apply(ui.Event{Kind: "view", View: e.View}, now)
	case "progress":
		s.App.Apply(ui.Event{Kind: "progress"}, now)
	case "heartbeat":
	default:
		// Unknown counted message types are a protocol gap: resync rather than drift.
		s.haveSnap = false
		return true, nil
	}
	s.valid(now)
	return false, nil
}
