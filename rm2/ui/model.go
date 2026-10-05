// Package ui is the production display core shared by the RM2 build and the
// host capture build: model, layout, rasteriser, refresh scheduler and touch.
package ui

// ProtocolVersion is the digest protocol this client understands.
const ProtocolVersion = 1

// Field is one digest field with explicit availability; nothing is ever shown
// as an empty success when it could not be read.
type Field struct {
	Available bool   `json:"available"`
	Text      string `json:"text"`
	Reason    string `json:"reason"`
}

type Option struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

type Question struct {
	Pending          bool     `json:"pending"`
	ID               string   `json:"id"`
	Kind             string   `json:"kind"`
	Text             string   `json:"text"`
	Options          []Option `json:"options"`
	ChoicesAvailable bool     `json:"choices_available"`
	Reason           string   `json:"reason"`
}

type FileEntry struct {
	Status string `json:"status"`
	Path   string `json:"path"`
}

type FileSet struct {
	Available bool        `json:"available"`
	Reason    string      `json:"reason"`
	Note      string      `json:"note"`
	Entries   []FileEntry `json:"entries"`
}

type Files struct {
	Tool     FileSet `json:"tool"`
	Worktree FileSet `json:"worktree"`
}

type Draft struct {
	Text     string `json:"text"`
	Revision int64  `json:"revision"`
	Status   string `json:"status"` // "", unsent, sending, uncertain
}

type Session struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Present     bool     `json:"present"`
	State       string   `json:"state"` // working needs_input done stuck unavailable
	StateReason string   `json:"state_reason"`
	Prompt      Field    `json:"prompt"`
	Message     Field    `json:"message"`
	Question    Question `json:"question"`
	Files       Files    `json:"files"`
	Draft       Draft    `json:"draft"`
}

type Selection struct {
	SessionID string `json:"session_id"`
	Revision  int64  `json:"revision"`
}

type Collector struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

type View struct {
	DigestPage int `json:"digest_page"`
	RowPage    int `json:"row_page"`
	DraftPage  int `json:"draft_page"` // -1 follows the end of the draft
}

type Snapshot struct {
	Protocol  int       `json:"protocol"`
	Epoch     string    `json:"epoch"`
	Revision  int64     `json:"revision"`
	Collector Collector `json:"collector"`
	Selection Selection `json:"selection"`
	View      View      `json:"view"`
	Sessions  []Session `json:"sessions"`
	ServerNow string    `json:"server_time"`
}

// Conn is the locally derived connection status. It is never inferred from the
// server: the stale timer runs on the device clock.
type Conn struct {
	Status        string // starting connecting fresh stale disconnected error suspended
	Endpoint      string
	Detail        string
	LastConfirmed string // wall-clock text of the last authoritative snapshot/heartbeat
}

type Model struct {
	Snap    Snapshot
	HasSnap bool
	Conn    Conn
	Notice  string // local action failure, e.g. "select refused: disconnected"
}

func (m *Model) session(id string) *Session {
	for i := range m.Snap.Sessions {
		if m.Snap.Sessions[i].ID == id {
			return &m.Snap.Sessions[i]
		}
	}
	return nil
}

func (m *Model) selected() *Session {
	if !m.HasSnap || m.Snap.Selection.SessionID == "" {
		return nil
	}
	return m.session(m.Snap.Selection.SessionID)
}

// StateText is the fixed human wording for each deterministic state.
func StateText(s *Session) string {
	switch s.State {
	case "working":
		return "working"
	case "needs_input":
		return "NEEDS YOUR INPUT"
	case "done":
		return "done (turn ended)"
	case "stuck":
		return "STUCK"
	case "unavailable":
		return "State unavailable"
	}
	return "State unavailable"
}
