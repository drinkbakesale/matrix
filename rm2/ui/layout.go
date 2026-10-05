package ui

import (
	"fmt"
	"strings"

	"matrixrm2/font"
)

// Native reMarkable 2 panel geometry. The client refuses any other geometry.
const (
	ScreenW     = 1404
	ScreenH     = 1872
	RowsPerPage = 7
	padX        = 24
)

// Fixed, disjoint regions. Row positions never move when a row changes state.
var (
	RegStatus      = Rect{0, 0, ScreenW, 64}
	RegRowPager    = Rect{0, 536, ScreenW, 64}
	RegDigest      = Rect{0, 608, ScreenW, 900} // includes its pager strip
	RegDigestPager = Rect{0, 1444, ScreenW, 64} // strip inside RegDigest
	RegTyped       = Rect{0, 1516, ScreenW, 356}
	ExitButton     = Rect{1232, 6, 160, 50}
)

func RegRow(i int) Rect { return Rect{0, 72 + i*66, ScreenW, 62} }

// drawable shrinks a region by one pixel on the right and bottom. AppLoad's
// FBController grows every partial update by one pixel (adjusted(0,0,1,1)), so
// keeping ink out of the last column/row guarantees the rectangle the panel
// finally receives is still inside the region.
func drawable(r Rect) Rect { return Rect{r.X, r.Y, r.W - 1, r.H - 1} }

const (
	textCols84  = (ScreenW - 2*padX) / CellW
	digestLines = (832 - 16) / LineH
	typedLines  = (356-16)/LineH - 1 // one line is the header
)

// wrapWords wraps s to cols half-width cells, breaking at spaces where it can.
func wrapWords(s string, cols int) []string {
	var out []string
	for _, para := range strings.Split(s, "\n") {
		para = strings.ReplaceAll(para, "\t", "    ")
		if para == "" {
			out = append(out, "")
			continue
		}
		line, lineCols := "", 0
		for _, word := range strings.SplitAfter(para, " ") {
			wc := textCols(word)
			if lineCols+wc <= cols {
				line += word
				lineCols += wc
				continue
			}
			if line != "" {
				out = append(out, strings.TrimRight(line, " "))
				line, lineCols = "", 0
			}
			for _, r := range word { // a word longer than the line is cut hard
				c := font.Cols(r)
				if lineCols+c > cols {
					out = append(out, line)
					line, lineCols = "", 0
				}
				line += string(r)
				lineCols += c
			}
		}
		out = append(out, strings.TrimRight(line, " "))
	}
	return out
}

type hardLine struct {
	text string
	hard bool // ends with a real newline in the source text
}

// wrapExact cuts s at exactly cols cells with no word logic, so the visible
// text can be reassembled byte-for-byte (used for the typed draft).
func wrapExact(s string, cols int) []hardLine {
	var out []hardLine
	paras := strings.Split(s, "\n")
	for pi, para := range paras {
		line, lineCols := "", 0
		for _, r := range para {
			if r == '\t' {
				r = ' '
			}
			c := font.Cols(r)
			if lineCols+c > cols {
				out = append(out, hardLine{line, false})
				line, lineCols = "", 0
			}
			line += string(r)
			lineCols += c
		}
		out = append(out, hardLine{line, pi < len(paras)-1})
	}
	return out
}

func joinHard(lines []hardLine) string {
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(l.text)
		if l.hard {
			b.WriteString("\n")
		}
	}
	return b.String()
}

func fieldLines(title string, f Field) []string {
	out := []string{"── " + title + " ──"}
	if !f.Available {
		return append(out, wrapWords("Unavailable: "+nonEmpty(f.Reason, "no reason recorded"), textCols84)...)
	}
	return append(out, wrapWords(f.Text, textCols84)...)
}

func nonEmpty(s, alt string) string {
	if strings.TrimSpace(s) == "" {
		return alt
	}
	return s
}

func fileSetLines(title string, fs FileSet) []string {
	out := []string{title}
	if !fs.Available {
		return append(out, wrapWords("  Unavailable: "+nonEmpty(fs.Reason, "no reason recorded"), textCols84)...)
	}
	if fs.Note != "" {
		out = append(out, wrapWords("  ("+fs.Note+")", textCols84)...)
	}
	if len(fs.Entries) == 0 {
		return append(out, "  none")
	}
	for _, e := range fs.Entries {
		out = append(out, wrapWords(fmt.Sprintf("  %-2s %s", e.Status, e.Path), textCols84)...)
	}
	return out
}

// digestAll builds every digest line for a session. Nothing is truncated:
// lines beyond one page are reached by paging.
func digestAll(m *Model) []string {
	if !m.HasSnap {
		return []string{"No data yet: waiting for the first snapshot from Matrix."}
	}
	if !m.Snap.Collector.OK {
		head := wrapWords("COLLECTOR ERROR: "+nonEmpty(m.Snap.Collector.Error, "no detail")+" — session list may be incomplete.", textCols84)
		if m.selected() == nil {
			return head
		}
		return append(head, digestSession(m.selected())...)
	}
	s := m.selected()
	if s == nil {
		if m.Snap.Selection.SessionID != "" {
			return wrapWords("Selected session "+m.Snap.Selection.SessionID+" is missing: it ended or is no longer listed.", textCols84)
		}
		return []string{"No session selected. Tap a row above."}
	}
	return digestSession(s)
}

func digestSession(s *Session) []string {
	var out []string
	head := s.Label + " — " + StateText(s)
	if !s.Present {
		head = s.Label + " — SESSION MISSING (ended or not listed)"
	}
	out = append(out, wrapWords(head, textCols84)...)
	if s.StateReason != "" {
		out = append(out, wrapWords("  "+s.StateReason, textCols84)...)
	}
	if s.Question.Pending {
		out = append(out, "── Waiting on you ("+nonEmpty(s.Question.Kind, "question")+") ──")
		out = append(out, wrapWords(s.Question.Text, textCols84)...)
		if !s.Question.ChoicesAvailable {
			out = append(out, wrapWords("  Choices unavailable: "+nonEmpty(s.Question.Reason, "no reason recorded"), textCols84)...)
		}
		for _, o := range s.Question.Options {
			out = append(out, wrapWords("  ["+o.Key+"] "+o.Label, textCols84)...)
		}
	}
	out = append(out, fieldLines("Your last prompt", s.Prompt)...)
	out = append(out, fieldLines("Claude's last complete message", s.Message)...)
	out = append(out, "── Files changed ──")
	out = append(out, fileSetLines("Written by this turn's tools:", s.Files.Tool)...)
	out = append(out, fileSetLines("Working tree (not attributed to this session):", s.Files.Worktree)...)
	return out
}

func pageCount(n, per int) int {
	if n <= per {
		return 1
	}
	return (n + per - 1) / per
}

func clampPage(p, pages int) int {
	if p < 0 {
		return 0
	}
	if p >= pages {
		return pages - 1
	}
	return p
}
