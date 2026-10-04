package wire

import (
	"encoding/hex"
	"errors"
	"sync"

	"matrixrm2/ui"
)

// Refresh is one panel refresh as observed after QTFB encoding and AppLoad's
// rectangle conversion.
type Refresh struct {
	Mode string `json:"mode"` // partial, clean, init
	Rect []int  `json:"rect"`
	Sent []int  `json:"sent_rect,omitempty"` // rectangle in the wire message
	AtMs int64  `json:"at_ms"`
	Wave int32  `json:"refresh_mode"`
	Raw  string `json:"raw"` // the 24 bytes exactly as sent on the wire, hex
}

// CaptureLink is an in-memory Link for the host build. It records nothing
// itself; it decodes the encoded client messages exactly as the panel side
// would, so observations are downstream of the production encoder.
type CaptureLink struct {
	mu     sync.Mutex
	fb     []byte
	Clock  func() int64
	Trace  []Refresh
	Ops    []ClientOp
	mode   int32
	inbox  chan Msg
	closed bool
	FailAt int // if >0, the Nth Send fails (backend failure injection)
	sends  int
	// Released is set when the client sent MESSAGE_TERMINATE.
	Released bool
}

func NewCaptureLink(clock func() int64) *CaptureLink {
	return &CaptureLink{fb: make([]byte, ui.ScreenW*ui.ScreenH*2), Clock: clock, inbox: make(chan Msg, 256), mode: -1}
}

func (c *CaptureLink) Framebuffer() []byte { return c.fb }

func (c *CaptureLink) Send(m Msg) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sends++
	if c.closed {
		return errors.New("panel link closed")
	}
	if c.FailAt > 0 && c.sends >= c.FailAt {
		return errors.New("panel link write failed")
	}
	op := DecodeClient(m)
	c.Ops = append(c.Ops, op)
	now := c.Clock()
	full := []int{0, 0, ui.ScreenW, ui.ScreenH}
	raw := hex.EncodeToString(m[:])
	switch op.Kind {
	case "terminate":
		c.Released = true
	case "refresh_mode":
		c.mode = op.Mode
	case "update_all":
		c.Trace = append(c.Trace, Refresh{Mode: "init", Rect: full, AtMs: now, Wave: c.mode, Raw: raw})
	case "partial":
		c.Trace = append(c.Trace, Refresh{Mode: "partial", Rect: PanelRect(op.Rect).List(), Sent: op.Rect.List(), AtMs: now, Wave: c.mode, Raw: raw})
	case "clean":
		c.Trace = append(c.Trace, Refresh{Mode: "clean", Rect: full, AtMs: now, Wave: c.mode, Raw: raw})
	}
	return nil
}

// Inject queues a server->client message (touch input) for Recv.
func (c *CaptureLink) Inject(m Msg) { c.inbox <- m }

func (c *CaptureLink) Recv() (Msg, error) {
	m, ok := <-c.inbox
	if !ok {
		return Msg{}, errors.New("panel link closed")
	}
	return m, nil
}

func (c *CaptureLink) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.inbox)
	}
	return nil
}

// Take returns and clears the refresh trace.
func (c *CaptureLink) Take() []Refresh {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := c.Trace
	c.Trace = nil
	return t
}

// Mono returns the framebuffer decoded back to one byte per pixel (0 or 255
// for pure black/white) so tests compare what was actually written.
func (c *CaptureLink) Mono() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]byte, ui.ScreenW*ui.ScreenH)
	for i := range out {
		if c.fb[i*2] != 0 || c.fb[i*2+1] != 0 {
			out[i] = 255
		}
	}
	return out
}
