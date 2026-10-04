package ui

import (
	"fmt"
	"sort"
)

// Panel is the final display backend. Partial must refresh only r; Clean is
// the panel's real full clean refresh; Init is the full paint allowed only at
// launch, resume or geometry initialisation.
type Panel interface {
	Init(f *Frame) error
	Partial(f *Frame, r Rect) error
	Clean() error
}

type Config struct {
	TypingCoalesceMs   int64 `json:"typing_coalesce_ms"`
	CleanAfterPartials int   `json:"clean_after_partials"`
	QuietMs            int64 `json:"quiet_ms"`
}

func DefaultConfig() Config {
	return Config{TypingCoalesceMs: 100, CleanAfterPartials: 100, QuietMs: 3000}
}

func (c Config) Validate() error {
	if c.TypingCoalesceMs < 0 || c.TypingCoalesceMs > 100 {
		return fmt.Errorf("typing_coalesce_ms must be 0..100, got %d", c.TypingCoalesceMs)
	}
	if c.CleanAfterPartials < 1 {
		return fmt.Errorf("clean_after_partials must be >= 1, got %d", c.CleanAfterPartials)
	}
	if c.QuietMs < 3000 {
		return fmt.Errorf("quiet_ms must be >= 3000, got %d", c.QuietMs)
	}
	return nil
}

type Touch struct {
	Type string // press, release, update
	ID   int
	X, Y int
}

type Event struct {
	Kind      string // snapshot session draft selection view progress conn touch suspend resume notice
	Snap      *Snapshot
	Session   *Session
	SessionID string
	Draft     *Draft
	Selection *Selection
	View      *View
	Conn      *Conn
	Touch     *Touch
	Notice    string
}

// Command is something the device asks the outside world to do.
type Command struct {
	Kind              string // select, view, exit
	SessionID         string
	SelectionRevision int64
	View              View
}

type App struct {
	M       Model
	Cfg     Config
	Panel   Panel
	OnCmd   func(Command)
	Visible map[string]string // last rendered text per region
	Fatal   error

	cur, next *Frame
	pg        pages
	started   bool

	dirty          map[string]bool
	typedDirtyAt   int64
	typedDirty     bool
	lastTypedFlush int64
	partials       int
	lastActivity   int64
	lastPaint      int64

	touches   map[int]*touchTrack
	multi     bool
	FullPaint int // count of Init calls (launch/resume only)
}

type touchTrack struct {
	x0, y0 int
	target string
	drag   bool
}

func NewApp(p Panel, cfg Config) *App {
	return &App{Cfg: cfg, Panel: p, Visible: map[string]string{}, cur: NewFrame(ScreenW, ScreenH), next: NewFrame(ScreenW, ScreenH),
		dirty: map[string]bool{}, touches: map[int]*touchTrack{}, pg: pages{draft: -1},
		lastTypedFlush: -1 << 40, M: Model{Conn: Conn{Status: "starting"}}}
}

func slotName(i int) string { return fmt.Sprintf("slot:%d", i) }

func (a *App) renderKey(f *Frame, key string) {
	var i int
	if n, _ := fmt.Sscanf(key, "slot:%d", &i); n == 1 {
		ss := a.rowPageSessions()
		for name := range a.Visible {
			if len(name) > 4 && name[:4] == "row:" && a.slotOf(name[4:]) < 0 {
				delete(a.Visible, name)
			}
		}
		if i < len(ss) {
			a.Visible[rowName(ss[i].ID)] = a.renderRow(f, i, &ss[i])
		} else {
			clear(f, RegRow(i))
		}
		return
	}
	a.Visible[key] = a.renderRegion(f, key)
}

func keyRect(key string) Rect {
	var i int
	if n, _ := fmt.Sscanf(key, "slot:%d", &i); n == 1 {
		return RegRow(i)
	}
	switch key {
	case NStatus:
		return RegStatus
	case NRowPager:
		return RegRowPager
	case NDigest:
		return RegDigest
	case NTyped:
		return RegTyped
	}
	return Rect{}
}

func allKeys() []string {
	k := []string{NStatus, NRowPager, NDigest, NTyped}
	for i := 0; i < RowsPerPage; i++ {
		k = append(k, slotName(i))
	}
	return k
}

// Start paints the whole screen once. This is the launch/resume full paint.
func (a *App) Start(now int64) {
	for _, k := range allKeys() {
		a.renderKey(a.cur, k)
	}
	copy(a.next.Pix, a.cur.Pix)
	a.fail(a.Panel.Init(a.cur))
	a.FullPaint++
	a.started = true
	a.partials = 0
	a.dirty = map[string]bool{}
	a.typedDirty = false
	a.lastPaint, a.lastActivity = now, now
}

func (a *App) fail(err error) {
	if err != nil && a.Fatal == nil {
		a.Fatal = err
	}
}

func (a *App) slotOf(id string) int {
	for i, s := range a.rowPageSessions() {
		if s.ID == id {
			return i
		}
	}
	return -1
}

func (a *App) markRow(id string) {
	if i := a.slotOf(id); i >= 0 {
		a.dirty[slotName(i)] = true
	}
}

func (a *App) markAllRows() {
	for i := 0; i < RowsPerPage; i++ {
		a.dirty[slotName(i)] = true
	}
	a.dirty[NRowPager] = true
}

func (a *App) markTyped(now int64) {
	if !a.typedDirty {
		a.typedDirty, a.typedDirtyAt = true, now
	}
}

// Apply feeds one event at time now (ms). It never paints; RunDue does.
func (a *App) Apply(ev Event, now int64) {
	switch ev.Kind {
	case "snapshot":
		oldSel := a.M.Snap.Selection.SessionID
		a.M.Snap, a.M.HasSnap = *ev.Snap, true
		if oldSel != ev.Snap.Selection.SessionID {
			a.pg.digest, a.pg.draft = 0, -1
		}
		a.markAllRows()
		a.dirty[NDigest], a.dirty[NStatus] = true, true
		a.markTyped(now)
	case "session":
		if !a.M.HasSnap {
			return
		}
		if cur := a.M.session(ev.Session.ID); cur != nil {
			draft := cur.Draft
			*cur = *ev.Session
			cur.Draft = draft // drafts travel only in draft events and snapshots
			a.markRow(cur.ID)
		} else {
			a.M.Snap.Sessions = append(a.M.Snap.Sessions, *ev.Session)
			a.markAllRows()
		}
		if a.M.Snap.Selection.SessionID == ev.Session.ID {
			a.dirty[NDigest] = true
		}
	case "draft":
		s := a.M.session(ev.SessionID)
		if s == nil || ev.Draft.Revision < s.Draft.Revision {
			return
		}
		s.Draft = *ev.Draft
		a.lastActivity = now
		if a.M.Snap.Selection.SessionID == ev.SessionID {
			a.pg.draft = -1
			a.markTyped(now)
		}
	case "selection":
		if !a.M.HasSnap || ev.Selection.Revision < a.M.Snap.Selection.Revision {
			return
		}
		old := a.M.Snap.Selection.SessionID
		a.M.Snap.Selection = *ev.Selection
		if old != ev.Selection.SessionID {
			a.pg.digest, a.pg.draft = 0, -1
			a.markRow(old)
			a.markRow(ev.Selection.SessionID)
			a.dirty[NDigest] = true
			a.markTyped(now)
		}
		a.lastActivity = now
	case "view":
		a.setPages(ev.View.DigestPage, ev.View.RowPage, ev.View.DraftPage, now)
	case "progress":
		a.lastActivity = now // streaming: no render, no spinner, no clock repaint
	case "conn":
		if a.M.Conn != *ev.Conn {
			a.M.Conn = *ev.Conn
			a.dirty[NStatus] = true
		}
	case "notice":
		if a.M.Notice != ev.Notice {
			a.M.Notice = ev.Notice
			a.dirty[NStatus] = true
		}
	case "suspend":
		a.M.Conn = Conn{Status: "suspended", Endpoint: a.M.Conn.Endpoint, LastConfirmed: a.M.Conn.LastConfirmed}
		a.dirty[NStatus] = true
	case "resume":
		a.M.Conn = Conn{Status: "stale", Endpoint: a.M.Conn.Endpoint, LastConfirmed: a.M.Conn.LastConfirmed, Detail: "resumed, waiting for snapshot"}
		a.Start(now)
	case "touch":
		a.lastActivity = now
		a.touch(*ev.Touch, now)
	}
}

func (a *App) setPages(digest, row, draft int, now int64) {
	if digest != a.pg.digest {
		a.pg.digest = digest
		a.dirty[NDigest] = true
	}
	if row != a.pg.row {
		a.pg.row = row
		a.markAllRows()
	}
	if draft != a.pg.draft {
		a.pg.draft = draft
		a.markTyped(now)
	}
	a.lastActivity = now
}

func (a *App) typedReadyAt() int64 {
	return max(a.typedDirtyAt, a.lastTypedFlush+a.Cfg.TypingCoalesceMs)
}

func (a *App) cleanOwed() bool { return a.partials >= a.Cfg.CleanAfterPartials }

func (a *App) cleanAt() int64 { return max(a.lastActivity, a.lastPaint) + a.Cfg.QuietMs }

func (a *App) PendingPaint() bool { return len(a.dirty) > 0 || a.typedDirty }

// NextDeadline is the earliest time RunDue has work, if any.
func (a *App) NextDeadline() (int64, bool) {
	if len(a.dirty) > 0 {
		return 0, true
	}
	if a.typedDirty {
		return a.typedReadyAt(), true
	}
	if a.cleanOwed() {
		return a.cleanAt(), true
	}
	return 0, false
}

// RunDue paints what is due at now. Regions are flushed as separate partial
// rectangles, each limited to the pixels that actually changed.
func (a *App) RunDue(now int64, allowClean bool) {
	if !a.started || a.Fatal != nil {
		return
	}
	keys := make([]string, 0, len(a.dirty))
	for k := range a.dirty {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		delete(a.dirty, k)
		a.flush(k, now)
	}
	if a.typedDirty && now >= a.typedReadyAt() {
		a.typedDirty = false
		a.lastTypedFlush = now
		a.flush(NTyped, now)
	}
	if allowClean && a.cleanOwed() && !a.PendingPaint() && now >= a.cleanAt() {
		a.fail(a.Panel.Clean())
		a.partials = 0
		a.lastPaint = now
	}
}

func (a *App) flush(key string, now int64) {
	r := keyRect(key)
	if r.Empty() {
		a.fail(fmt.Errorf("refusing to paint unknown region %q", key))
		return
	}
	a.renderKey(a.next, key)
	box := diffBox(a.cur, a.next, r)
	if box.Empty() {
		return // identical pixels: no refresh at all
	}
	copyRect(a.cur, a.next, box)
	a.fail(a.Panel.Partial(a.cur, box))
	a.partials++
	a.lastPaint = now
}

// Frame returns the frame as last sent to the panel.
func (a *App) Frame() *Frame { return a.cur }

func (a *App) States() map[string]string {
	out := map[string]string{}
	for _, s := range a.M.Snap.Sessions {
		out[s.ID] = s.State
	}
	return out
}

func (a *App) target(x, y int) string {
	if x < 0 || y < 0 || x >= ScreenW || y >= ScreenH {
		return ""
	}
	if ExitButton.Contains(x, y) {
		return "exit"
	}
	for i, s := range a.rowPageSessions() {
		if RegRow(i).Contains(x, y) {
			return "row:" + s.ID
		}
	}
	half := func(r Rect, name string) string {
		if !r.Contains(x, y) {
			return ""
		}
		if x < r.X+r.W/3 {
			return name + ":prev"
		}
		if x >= r.X+2*r.W/3 {
			return name + ":next"
		}
		return ""
	}
	if t := half(RegRowPager, "rowpage"); t != "" {
		return t
	}
	if t := half(RegDigestPager, "digestpage"); t != "" {
		return t
	}
	if RegTyped.Contains(x, y) {
		if y < RegTyped.Y+RegTyped.H/2 {
			return "draftpage:prev"
		}
		return "draftpage:next"
	}
	return ""
}

const dragLimit = 24

func (a *App) touch(t Touch, now int64) {
	switch t.Type {
	case "press":
		if len(a.touches) > 0 {
			a.multi = true
		}
		a.touches[t.ID] = &touchTrack{x0: t.X, y0: t.Y, target: a.target(t.X, t.Y)}
	case "update":
		if tr := a.touches[t.ID]; tr != nil {
			if abs(t.X-tr.x0) > dragLimit || abs(t.Y-tr.y0) > dragLimit {
				tr.drag = true
			}
		}
	case "release":
		tr := a.touches[t.ID]
		delete(a.touches, t.ID)
		multi := a.multi
		if len(a.touches) == 0 {
			a.multi = false
		}
		if tr == nil || multi || tr.drag || tr.target == "" {
			return
		}
		if abs(t.X-tr.x0) > dragLimit || abs(t.Y-tr.y0) > dragLimit || a.target(t.X, t.Y) != tr.target {
			return
		}
		a.act(tr.target, now)
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func (a *App) emit(c Command) {
	if a.OnCmd != nil {
		a.OnCmd(c)
	}
}

func (a *App) act(target string, now int64) {
	switch target {
	case "exit":
		a.emit(Command{Kind: "exit"})
	case "rowpage:prev":
		a.setPages(a.pg.digest, clampPage(a.pg.row-1, pageCount(len(a.M.Snap.Sessions), RowsPerPage)), a.pg.draft, now)
	case "rowpage:next":
		a.setPages(a.pg.digest, clampPage(a.pg.row+1, pageCount(len(a.M.Snap.Sessions), RowsPerPage)), a.pg.draft, now)
	case "digestpage:prev", "digestpage:next":
		_, page, pc, _ := a.digestPage()
		d := 1
		if target == "digestpage:prev" {
			d = -1
		}
		a.setPages(clampPage(page+d, pc), a.pg.row, a.pg.draft, now)
	case "draftpage:prev", "draftpage:next":
		s := a.M.selected()
		if s == nil {
			return
		}
		pc := pageCount(len(wrapExact(s.Draft.Text, textCols84)), typedLines)
		page := a.pg.draft
		if page < 0 || page >= pc {
			page = pc - 1
		}
		if target == "draftpage:prev" {
			page--
		} else {
			page++
		}
		page = clampPage(page, pc)
		if page == pc-1 {
			page = -1
		}
		a.setPages(a.pg.digest, a.pg.row, page, now)
	default:
		if len(target) > 4 && target[:4] == "row:" {
			// Not optimistic: the mark moves only when the server confirms.
			a.emit(Command{Kind: "select", SessionID: target[4:], SelectionRevision: a.M.Snap.Selection.Revision})
		}
		return
	}
	a.emit(Command{Kind: "view", View: View{DigestPage: a.pg.digest, RowPage: a.pg.row, DraftPage: a.pg.draft}})
}
