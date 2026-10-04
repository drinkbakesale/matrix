package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"matrixrm2/netc"
	"matrixrm2/ui"
	"matrixrm2/wire"
)

// The script command drives the production App, scheduler, rasteriser and
// QTFB encoder with a fake clock and an in-memory panel link. It is the host
// capture used by tests; no rendering or scheduling logic lives here.

type scriptSession struct {
	ID      string `json:"id"`
	State   string `json:"state"`
	Prompt  string `json:"prompt"`
	Message string `json:"message"`
}

type scriptStep struct {
	Op      string          `json:"op"`
	AtMs    int64           `json:"at_ms"`
	Session string          `json:"session"`
	Text    string          `json:"text"`
	State   string          `json:"state"`
	Raw     json.RawMessage `json:"raw"`   // snapshot/session/selection/view/conn/draft payloads
	Touch   []int32         `json:"touch"` // inputType, devID, x, y  (QTFB encoded and decoded)
	Net     string          `json:"net"`   // connecting, closed, message: drives the production Sync
	Type    string          `json:"type"`  // SSE message type for net=message
	FailAt  int             `json:"fail_at"`
}

type scriptInput struct {
	Screen  []int `json:"screen"`
	Initial struct {
		Selected string          `json:"selected"`
		Sessions []scriptSession `json:"sessions"`
		Snapshot json.RawMessage `json:"snapshot"`
	} `json:"initial"`
	Config    ui.Config    `json:"config"`
	Steps     []scriptStep `json:"steps"`
	FramesDir string       `json:"frames_dir"`
	Conn      *ui.Conn     `json:"conn"`
}

type scriptObs struct {
	Refreshes   []map[string]any  `json:"refreshes"`
	VisibleText map[string]string `json:"visible_text"`
	States      map[string]string `json:"states"`
	Commands    []ui.Command      `json:"commands"`
	Fatal       string            `json:"fatal"`
	Conn        string            `json:"conn"`
	FullPaints  int               `json:"full_paints"`
	Resync      bool              `json:"resync"`
	SyncError   string            `json:"sync_error,omitempty"`
	ConnDetail  ui.Conn           `json:"conn_detail"`
	Frame       string            `json:"frame,omitempty"`
}

func field(s string) ui.Field { return ui.Field{Available: true, Text: s} }

func scriptMain(in io.Reader, out io.Writer) error {
	var inp scriptInput
	if err := json.NewDecoder(in).Decode(&inp); err != nil {
		return fmt.Errorf("script input: %w", err)
	}
	if len(inp.Screen) == 2 && (inp.Screen[0] != ui.ScreenW || inp.Screen[1] != ui.ScreenH) {
		return fmt.Errorf("unsupported geometry %v: this client renders only native 1404x1872", inp.Screen)
	}
	if err := inp.Config.Validate(); err != nil {
		return err
	}
	now := int64(0)
	link := wire.NewCaptureLink(func() int64 { return now })
	app := ui.NewApp(&wire.Panel{L: link, Mode: wire.RefreshFast}, inp.Config)
	var cmds []ui.Command
	app.OnCmd = func(c ui.Command) { cmds = append(cmds, c) }

	var snap ui.Snapshot
	if len(inp.Initial.Snapshot) > 0 {
		if err := json.Unmarshal(inp.Initial.Snapshot, &snap); err != nil {
			return fmt.Errorf("initial snapshot: %w", err)
		}
	} else {
		snap = ui.Snapshot{Protocol: ui.ProtocolVersion, Epoch: "script", Revision: 1, Collector: ui.Collector{OK: true},
			Selection: ui.Selection{SessionID: inp.Initial.Selected, Revision: 1}}
		for _, s := range inp.Initial.Sessions {
			none := ui.FileSet{Available: true}
			snap.Sessions = append(snap.Sessions, ui.Session{ID: s.ID, Label: s.ID, Present: true, State: s.State,
				Prompt: field(s.Prompt), Message: field(s.Message), Files: ui.Files{Tool: none, Worktree: none}})
		}
	}
	conn := ui.Conn{Status: "fresh", Endpoint: "script"}
	if inp.Conn != nil {
		conn = *inp.Conn
	}
	app.Apply(ui.Event{Kind: "conn", Conn: &conn}, now)
	app.Apply(ui.Event{Kind: "snapshot", Snap: &snap}, now)
	sync := netc.NewSync(app, func() string { return fmt.Sprintf("t+%dms", now) })
	app.Start(now) // initial view, then the trace is cleared
	link.Take()

	sessionCopy := func(id string) (*ui.Session, error) {
		for _, s := range app.M.Snap.Sessions {
			if s.ID == id {
				c := s
				return &c, nil
			}
		}
		return nil, fmt.Errorf("step names unknown session %q", id)
	}
	advance := func(to int64) {
		for i := 0; i < 10000; i++ {
			dl, ok := app.NextDeadline()
			if !ok || max(dl, now) > to {
				break
			}
			now = max(dl, now)
			app.RunDue(now, true)
		}
		now = max(now, to)
		app.RunDue(now, true)
	}
	drainPaint := func(limit int64) {
		for i := 0; i < 10000; i++ {
			dl, ok := app.NextDeadline()
			if !ok || !app.PendingPaint() || max(dl, now) > limit {
				return
			}
			now = max(dl, now)
			app.RunDue(now, false)
		}
	}

	regions := map[string][]int{}
	steps := make([]scriptObs, 0, len(inp.Steps))
	var frameErr error
	emit := func(i int, o scriptObs) {
		if inp.FramesDir != "" {
			o.Frame = filepath.Join(inp.FramesDir, fmt.Sprintf("step-%03d.pgm", i))
			if err := writePGM(o.Frame, link.Mono()); err != nil && frameErr == nil {
				frameErr = err
			}
		}
		steps = append(steps, o)
	}
	for i, st := range inp.Steps {
		cmds = nil
		resync, syncErr := false, ""
		if st.Op == "tick" {
			advance(st.AtMs)
			sync.Tick(now)
			app.RunDue(now, true)
		} else if st.Op == "net" {
			advance(max(now, st.AtMs))
			switch st.Net {
			case "connecting":
				sync.Connecting(st.Text, now)
			case "closed":
				sync.Closed(st.Text, now)
			case "message":
				r, err := sync.Message(st.Type, st.Raw, now)
				resync = r
				if err != nil {
					syncErr = err.Error()
				}
			default:
				return fmt.Errorf("step %d: unknown net kind %q", i, st.Net)
			}
			drainPaint(now + 150)
		} else {
			advance(max(now, st.AtMs))
			var ev ui.Event
			switch st.Op {
			case "stream":
				ev = ui.Event{Kind: "progress", SessionID: st.Session}
			case "complete_message", "state":
				s, err := sessionCopy(st.Session)
				if err != nil {
					return err
				}
				if st.Op == "complete_message" {
					s.Message = field(st.Text)
				}
				if st.State != "" {
					s.State = st.State
				}
				ev = ui.Event{Kind: "session", Session: s}
			case "draft":
				s, err := sessionCopy(st.Session)
				if err != nil {
					return err
				}
				ev = ui.Event{Kind: "draft", SessionID: st.Session, Draft: &ui.Draft{Text: st.Text, Revision: s.Draft.Revision + 1, Status: "unsent"}}
			case "touch":
				if len(st.Touch) != 4 {
					return fmt.Errorf("step %d: touch needs [inputType, devID, x, y]", i)
				}
				sev := wire.DecodeServer(wire.EncodeUserInput(st.Touch[0], st.Touch[1], st.Touch[2], st.Touch[3]))
				if sev.Touch == nil {
					emit(i, observe(app, link, cmds, regions))
					continue
				}
				ev = ui.Event{Kind: "touch", Touch: sev.Touch}
			case "suspend", "resume":
				ev = ui.Event{Kind: st.Op}
			case "fail_panel":
				link.FailAt = st.FailAt
				emit(i, observe(app, link, cmds, regions))
				continue
			case "invalid_rect":
				// Exercises the encoder guard directly: a null rectangle must be refused.
				_, err := wire.EncodeUpdatePartial(ui.Rect{})
				o := observe(app, link, cmds, regions)
				if err != nil {
					o.Fatal = err.Error()
				}
				emit(i, o)
				continue
			default:
				var err error
				ev, err = rawEvent(st)
				if err != nil {
					return fmt.Errorf("step %d: %w", i, err)
				}
			}
			app.Apply(ev, now)
			drainPaint(now + 150)
		}
		o := observe(app, link, cmds, regions)
		o.Resync, o.SyncError = resync, syncErr
		emit(i, o)
	}
	if frameErr != nil {
		return frameErr
	}
	for name, r := range app.Regions() {
		regions[name] = r.List()
	}
	return json.NewEncoder(out).Encode(map[string]any{"regions": regions, "steps": steps,
		"line_height": ui.LineH, "exit_button": ui.ExitButton.List(), "digest_pager": ui.RegDigestPager.List()})
}

func rawEvent(st scriptStep) (ui.Event, error) {
	ev := ui.Event{Kind: st.Op, SessionID: st.Session}
	var err error
	switch st.Op {
	case "snapshot":
		ev.Snap = &ui.Snapshot{}
		err = json.Unmarshal(st.Raw, ev.Snap)
	case "session":
		ev.Session = &ui.Session{}
		err = json.Unmarshal(st.Raw, ev.Session)
	case "selection":
		ev.Selection = &ui.Selection{}
		err = json.Unmarshal(st.Raw, ev.Selection)
	case "view":
		ev.View = &ui.View{}
		err = json.Unmarshal(st.Raw, ev.View)
	case "conn":
		ev.Conn = &ui.Conn{}
		err = json.Unmarshal(st.Raw, ev.Conn)
	case "rawdraft":
		ev.Kind = "draft"
		ev.Draft = &ui.Draft{}
		err = json.Unmarshal(st.Raw, ev.Draft)
	default:
		err = fmt.Errorf("unknown op %q", st.Op)
	}
	return ev, err
}

func observe(app *ui.App, link *wire.CaptureLink, cmds []ui.Command, regions map[string][]int) scriptObs {
	cur := app.Regions()
	for name, r := range cur {
		regions[name] = r.List()
	}
	o := scriptObs{Refreshes: []map[string]any{}, VisibleText: map[string]string{}, States: app.States(), Commands: cmds, Conn: app.M.Conn.Status, ConnDetail: app.M.Conn, FullPaints: app.FullPaint}
	for k, v := range app.Visible {
		o.VisibleText[k] = v
	}
	if app.Fatal != nil {
		o.Fatal = app.Fatal.Error()
	}
	for _, r := range link.Take() {
		region := "ESCAPED"
		if r.Mode != "partial" {
			region = "screen"
		} else {
			pr := ui.Rect{X: r.Rect[0], Y: r.Rect[1], W: r.Rect[2], H: r.Rect[3]}
			for name, reg := range cur {
				if pr.Intersect(reg) == pr {
					region = name
				}
			}
		}
		o.Refreshes = append(o.Refreshes, map[string]any{"mode": r.Mode, "rect": r.Rect, "sent_rect": r.Sent, "region": region, "at_ms": r.AtMs, "refresh_mode": r.Wave})
	}
	return o
}

func writePGM(path string, mono []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	head := []byte(fmt.Sprintf("P5\n%d %d\n255\n", ui.ScreenW, ui.ScreenH))
	return os.WriteFile(path, append(head, mono...), 0o644)
}
