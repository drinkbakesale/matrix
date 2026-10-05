package ui

import (
	"fmt"
	"strings"
)

// Region names used in traces and by the scheduler.
const (
	NStatus   = "status"
	NRowPager = "rowpager"
	NDigest   = "digest"
	NTyped    = "typed"
)

func rowName(id string) string { return "row:" + id }

// local paging state lives on the device so stale content stays readable offline.
type pages struct {
	digest, row int
	draft       int // -1 follows the end
}

func (a *App) rowPageSessions() []Session {
	all := a.M.Snap.Sessions
	pc := pageCount(len(all), RowsPerPage)
	a.pg.row = clampPage(a.pg.row, pc)
	start := a.pg.row * RowsPerPage
	end := min(start+RowsPerPage, len(all))
	if start > end {
		start = end
	}
	return all[start:end]
}

// Regions returns every named region currently laid out (rows of the visible page).
func (a *App) Regions() map[string]Rect {
	out := map[string]Rect{NStatus: RegStatus, NRowPager: RegRowPager, NDigest: RegDigest, NTyped: RegTyped}
	ss := a.rowPageSessions()
	for i := 0; i < RowsPerPage; i++ {
		if i < len(ss) {
			out[rowName(ss[i].ID)] = RegRow(i)
		} else {
			out[slotName(i)] = RegRow(i) // an empty row slot is still its own region
		}
	}
	return out
}

func clear(f *Frame, r Rect) *canvas {
	c := &canvas{f: f, clip: drawable(r)}
	c.fill(r, 255)
	return c
}

func (a *App) renderStatus(f *Frame) string {
	c := clear(f, RegStatus)
	cn := a.M.Conn
	var text string
	alarm := true
	switch cn.Status {
	case "fresh":
		text, alarm = "LIVE · "+cn.Endpoint, false
	case "stale":
		text = "STALE — last confirmed " + nonEmpty(cn.LastConfirmed, "never") + " · " + cn.Endpoint
	case "disconnected":
		text = "DISCONNECTED — last confirmed " + nonEmpty(cn.LastConfirmed, "never") + " · retrying " + cn.Endpoint
	case "suspended":
		text = "SUSPENDED — content below is not live"
	case "error":
		text = "ERROR: " + nonEmpty(cn.Detail, "no detail")
	case "connecting":
		text = "CONNECTING · " + cn.Endpoint + " — content below is not confirmed"
	default:
		text = "STARTING — no data yet"
	}
	if cn.Status != "error" && cn.Detail != "" {
		text += " (" + cn.Detail + ")"
	}
	if a.M.HasSnap && !a.M.Snap.Collector.OK {
		text, alarm = "COLLECTOR ERROR · "+text, true
	}
	if a.M.Notice != "" {
		text += " | " + a.M.Notice
	}
	ink := byte(0)
	if alarm {
		c.fill(Rect{0, 0, ExitButton.X - 12, RegStatus.H}, 0)
		ink = 255
	}
	maxCols := (ExitButton.X - 12 - 2*padX) / CellW
	shown := cutCols(text, maxCols)
	c.text(padX, 16, shown, ink)
	c.fill(ExitButton, 0)
	c.fill(Rect{ExitButton.X + 3, ExitButton.Y + 3, ExitButton.W - 6, ExitButton.H - 6}, 255)
	c.text(ExitButton.X+48, ExitButton.Y+9, "Exit", 0)
	return shown
}

func cutCols(s string, cols int) string {
	if textCols(s) <= cols {
		return s
	}
	out, n := "", 0
	for _, r := range s {
		if n+2 > cols-1 {
			break
		}
		out += string(r)
		n += textCols(string(r))
	}
	return out + "…"
}

func (a *App) renderRow(f *Frame, i int, s *Session) string {
	r := RegRow(i)
	c := clear(f, r)
	selected := a.M.HasSnap && a.M.Snap.Selection.SessionID == s.ID
	if selected {
		c.fill(Rect{r.X, r.Y, 14, r.H}, 0)
	}
	st := StateText(s)
	if !s.Present {
		st = "MISSING"
	}
	stCols := textCols(st)
	boxW := stCols*CellW + 24
	boxX := ScreenW - padX - boxW
	label := cutCols(s.Label, (boxX-40-padX)/CellW)
	c.text(40, r.Y+14, label, 0)
	if s.State == "needs_input" || s.State == "stuck" || !s.Present {
		c.fill(Rect{boxX, r.Y + 6, boxW, GlyphH + 16}, 0)
		c.text(boxX+12, r.Y+14, st, 255)
	} else {
		c.text(boxX+12, r.Y+14, st, 0)
	}
	c.fill(Rect{r.X, r.Y + r.H - 3, r.W, 2}, 0)
	mark := "  "
	if selected {
		mark = "> "
	}
	return mark + label + " | " + st
}

func pagerText(what string, page, pages, from, to, total int) string {
	if total == 0 {
		return what + ": none"
	}
	return fmt.Sprintf("%s %d–%d of %d · page %d/%d", what, from, to, total, page+1, pages)
}

func (a *App) renderPager(c *canvas, r Rect, label string, page, pages int) string {
	if pages > 1 {
		c.fill(Rect{r.X + 8, r.Y + 6, 220, r.H - 14}, 0)
		c.text(r.X+44, r.Y+14, "< Prev", 255)
		c.fill(Rect{r.X + r.W - 228, r.Y + 6, 220, r.H - 14}, 0)
		c.text(r.X+r.W-192, r.Y+14, "Next >", 255)
	}
	c.text(r.X+(r.W-textCols(label)*CellW)/2, r.Y+14, label, 0)
	return label
}

func (a *App) renderRowPager(f *Frame) string {
	n := len(a.M.Snap.Sessions)
	pc := pageCount(n, RowsPerPage)
	a.pg.row = clampPage(a.pg.row, pc)
	from := a.pg.row*RowsPerPage + 1
	to := min(from+RowsPerPage-1, n)
	return a.renderPager(clear(f, RegRowPager), RegRowPager, pagerText("Sessions", a.pg.row, pc, from, to, n), a.pg.row, pc)
}

func (a *App) digestPage() (lines []string, page, pc, total int) {
	all := digestAll(&a.M)
	pc = pageCount(len(all), digestLines)
	a.pg.digest = clampPage(a.pg.digest, pc)
	start := a.pg.digest * digestLines
	return all[start:min(start+digestLines, len(all))], a.pg.digest, pc, len(all)
}

func (a *App) renderDigest(f *Frame) string {
	c := clear(f, RegDigest)
	lines, page, pc, total := a.digestPage()
	for i, l := range lines {
		c.text(padX, RegDigest.Y+8+i*LineH, l, 0)
	}
	from := page*digestLines + 1
	a.renderPager(c, RegDigestPager, pagerText("Digest lines", page, pc, from, from+len(lines)-1, total), page, pc)
	return strings.Join(lines, "\n")
}

func (a *App) renderTyped(f *Frame) (header, content string) {
	c := clear(f, RegTyped)
	c.fill(Rect{0, RegTyped.Y, ScreenW, 3}, 0)
	s := a.M.selected()
	if s == nil {
		header = "Draft: no session selected"
		c.text(padX, RegTyped.Y+10, header, 0)
		return header, ""
	}
	all := wrapExact(s.Draft.Text, textCols84)
	if s.Draft.Text == "" {
		all = nil
	}
	pc := pageCount(len(all), typedLines)
	page := a.pg.draft
	if page < 0 || page >= pc {
		page = pc - 1
	}
	start := page * typedLines
	end := min(start+typedLines, len(all))
	vis := all[start:end]
	switch {
	case s.Draft.Status == "uncertain":
		header = "DELIVERY UNCERTAIN — sent once, not confirmed, will NOT be resent"
	case s.Draft.Status == "sending":
		header = "Sending to " + s.Label + "…"
	case len(all) == 0:
		header = "Draft for " + s.Label + ": empty"
	default:
		header = "Draft for " + s.Label + " — NOT SENT"
	}
	if pc > 1 {
		header += fmt.Sprintf(" · lines %d–%d of %d", start+1, end, len(all))
	}
	header = cutCols(header, textCols84)
	c.text(padX, RegTyped.Y+10, header, 0)
	for i, l := range vis {
		c.text(padX, RegTyped.Y+10+(i+1)*LineH, l.text, 0)
	}
	return header, joinHard(vis)
}

// renderRegion draws one named region into f and returns its visible text.
func (a *App) renderRegion(f *Frame, name string) string {
	switch name {
	case NStatus:
		return a.renderStatus(f)
	case NRowPager:
		return a.renderRowPager(f)
	case NDigest:
		return a.renderDigest(f)
	case NTyped:
		_, content := a.renderTyped(f)
		return content
	}
	if id, ok := strings.CutPrefix(name, "row:"); ok {
		for i, s := range a.rowPageSessions() {
			if s.ID == id {
				return a.renderRow(f, i, &a.rowPageSessions()[i])
			}
		}
	}
	return ""
}

// rowSlotRect clears row slots that hold no session on the current page.
func (a *App) renderEmptySlots(f *Frame) {
	for i := len(a.rowPageSessions()); i < RowsPerPage; i++ {
		clear(f, RegRow(i))
	}
}

// TextScreen renders plain lines on a blank full screen (first-run report and
// fatal start-up messages). It is only ever sent with a launch full paint.
func TextScreen(lines []string) *Frame {
	f := NewFrame(ScreenW, ScreenH)
	c := &canvas{f: f, clip: Rect{0, 0, ScreenW, ScreenH}}
	y := 40
	for _, l := range lines {
		for _, w := range wrapWords(l, textCols84) {
			c.text(padX, y, w, 0)
			y += LineH
		}
	}
	return f
}

// View is the paging actually shown, after clamping to the content.
func (a *App) View() View {
	_, page, _, _ := a.digestPage()
	a.rowPageSessions()
	return View{DigestPage: page, RowPage: a.pg.row, DraftPage: a.pg.draft}
}
