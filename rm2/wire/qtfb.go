// Package wire is the final display backend: it encodes frames and refreshes
// into the QTFB protocol spoken by AppLoad (rm-appload v0.6.0, commit
// 7ec0830c97570bf5c607f3f458ea78edfa03e5a3, src/qtfb/common.h) and decodes
// forwarded touch input. Layouts below are the 32-bit ARM struct layouts.
package wire

import (
	"encoding/binary"
	"fmt"

	"matrixrm2/ui"
)

const (
	MsgSize = 24

	MsgInitialize         = 0
	MsgUpdate             = 1
	MsgTerminate          = 3
	MsgUserInput          = 4
	MsgSetRefreshMode     = 5
	MsgRequestFullRefresh = 6
	MsgDeviceStateChanged = 7
	MsgDeviceStateInit    = 8

	FbFmtRM2 = 0 // FBFMT_RM2FB: 1404x1872 RGB565

	UpdateAll     = 0
	UpdatePartial = 1

	// xochitl display modes selectable through MESSAGE_SET_REFRESH_MODE.
	RefreshUFast   = 0
	RefreshFast    = 1
	RefreshAnimate = 2
	RefreshContent = 3
	RefreshUI      = 4

	InputTouchPress   = 0x10
	InputTouchRelease = 0x11
	InputTouchUpdate  = 0x12

	SocketPath = "/tmp/qtfb.sock"
)

type Msg [MsgSize]byte

func put(m *Msg, off int, v int32) { binary.LittleEndian.PutUint32(m[off:], uint32(v)) }
func get(m Msg, off int) int32     { return int32(binary.LittleEndian.Uint32(m[off:])) }

func EncodeInit(key int32) Msg {
	var m Msg
	m[0] = MsgInitialize
	put(&m, 4, key)
	m[8] = FbFmtRM2
	return m
}

func EncodeUpdateAll() Msg {
	var m Msg
	m[0] = MsgUpdate
	put(&m, 4, UpdateAll)
	return m
}

// EncodeUpdatePartial refuses empty or out-of-screen rectangles: AppLoad
// treats an invalid rectangle as a complete repaint, which must never happen
// by accident.
func EncodeUpdatePartial(r ui.Rect) (Msg, error) {
	var m Msg
	if r.W <= 0 || r.H <= 0 || r.X < 0 || r.Y < 0 || r.X+r.W > ui.ScreenW || r.Y+r.H > ui.ScreenH {
		return m, fmt.Errorf("refusing invalid partial rectangle %v", r)
	}
	m[0] = MsgUpdate
	put(&m, 4, UpdatePartial)
	put(&m, 8, int32(r.X))
	put(&m, 12, int32(r.Y))
	put(&m, 16, int32(r.W))
	put(&m, 20, int32(r.H))
	return m, nil
}

func EncodeRefreshMode(mode int32) (Msg, error) {
	var m Msg
	if mode < 0 || mode > 4 {
		return m, fmt.Errorf("refresh mode %d is not one AppLoad accepts (0..4)", mode)
	}
	m[0] = MsgSetRefreshMode
	put(&m, 4, mode)
	return m, nil
}

func EncodeFullRefresh() Msg { var m Msg; m[0] = MsgRequestFullRefresh; return m }
func EncodeTerminate() Msg   { var m Msg; m[0] = MsgTerminate; return m }

// EncodeUserInput builds the server->client input packet (used by the host
// panel simulator and tests to inject production-format touch events).
func EncodeUserInput(inputType, devID, x, y int32) Msg {
	var m Msg
	m[0] = MsgUserInput
	put(&m, 4, inputType)
	put(&m, 8, devID)
	put(&m, 12, x)
	put(&m, 16, y)
	return m
}

func EncodeInitResponse(shmKey, shmSize int32) Msg {
	var m Msg
	m[0] = MsgInitialize
	put(&m, 4, shmKey)
	put(&m, 8, shmSize)
	return m
}

// ServerEvent is a decoded server->client message.
type ServerEvent struct {
	Type            byte
	ShmKey, ShmSize int32
	Touch           *ui.Touch
	Rotation        int32
	Raw             Msg
}

func DecodeServer(m Msg) ServerEvent {
	ev := ServerEvent{Type: m[0], Raw: m}
	switch m[0] {
	case MsgInitialize:
		ev.ShmKey, ev.ShmSize = get(m, 4), get(m, 8)
	case MsgUserInput:
		t := ui.Touch{ID: int(get(m, 8)), X: int(get(m, 12)), Y: int(get(m, 16))}
		switch get(m, 4) {
		case InputTouchPress:
			t.Type = "press"
		case InputTouchRelease:
			t.Type = "release"
		case InputTouchUpdate:
			t.Type = "update"
		default:
			return ev // pen, buttons and virtual keys are ignored: no pointer, no keyboard on the RM2
		}
		ev.Touch = &t
	case MsgDeviceStateChanged, MsgDeviceStateInit:
		ev.Rotation = get(m, 8)
	}
	return ev
}

// ClientOp is a decoded client->server message, as the panel side sees it.
type ClientOp struct {
	Kind string // init update_all partial refresh_mode clean terminate unknown
	Rect ui.Rect
	Mode int32
}

// PanelRect is the rectangle AppLoad hands to the display for a partial
// update at rotation 0 without scaling: FBController::markedUpdate applies
// adjusted(0,0,1,1), growing it by one pixel right and down.
func PanelRect(r ui.Rect) ui.Rect { return ui.Rect{X: r.X, Y: r.Y, W: r.W + 1, H: r.H + 1} }

func DecodeClient(m Msg) ClientOp {
	switch m[0] {
	case MsgInitialize:
		return ClientOp{Kind: "init", Mode: int32(m[8])}
	case MsgUpdate:
		if get(m, 4) == UpdateAll {
			return ClientOp{Kind: "update_all"}
		}
		if get(m, 4) == UpdatePartial {
			return ClientOp{Kind: "partial", Rect: ui.Rect{X: int(get(m, 8)), Y: int(get(m, 12)), W: int(get(m, 16)), H: int(get(m, 20))}}
		}
	case MsgSetRefreshMode:
		return ClientOp{Kind: "refresh_mode", Mode: get(m, 4)}
	case MsgRequestFullRefresh:
		return ClientOp{Kind: "clean"}
	case MsgTerminate:
		return ClientOp{Kind: "terminate"}
	}
	return ClientOp{Kind: "unknown"}
}

// CheckInit validates AppLoad's answer to MESSAGE_INITIALIZE. Anything other
// than an initialise response carrying a 1404x1872 RGB565 framebuffer means the
// installed display backend does not speak the protocol this client was built
// for; the caller must stop before drawing.
func CheckInit(m Msg) (ServerEvent, error) {
	ev := DecodeServer(m)
	want := int32(ui.ScreenW * ui.ScreenH * 2)
	if ev.Type != MsgInitialize {
		return ev, fmt.Errorf("incompatible display backend: expected an initialise response (type %d), got message type %d", MsgInitialize, ev.Type)
	}
	if ev.ShmSize != want {
		return ev, fmt.Errorf("incompatible display backend: framebuffer is %d bytes, this client needs %d (1404x1872 RGB565)", ev.ShmSize, want)
	}
	return ev, nil
}

// Release tells the backend the client is done (MESSAGE_TERMINATE) and closes
// the link, so AppLoad drops the framebuffer and returns input and display to
// the stock interface.
func Release(l Link) error {
	err := l.Send(EncodeTerminate())
	if cerr := l.Close(); err == nil {
		err = cerr
	}
	return err
}

// Link carries QTFB messages and exposes the shared RGB565 framebuffer.
type Link interface {
	Send(Msg) error
	Recv() (Msg, error)
	Framebuffer() []byte
	Close() error
}

// Panel implements ui.Panel over a Link.
type Panel struct {
	L    Link
	Mode int32
}

func rgb565(v byte) (byte, byte) {
	p := uint16(v>>3)<<11 | uint16(v>>2)<<5 | uint16(v>>3)
	return byte(p), byte(p >> 8)
}

func (p *Panel) blit(f *ui.Frame, r ui.Rect) error {
	fb := p.L.Framebuffer()
	if len(fb) != ui.ScreenW*ui.ScreenH*2 {
		return fmt.Errorf("framebuffer is %d bytes, want %d (1404x1872 RGB565)", len(fb), ui.ScreenW*ui.ScreenH*2)
	}
	for y := r.Y; y < r.Y+r.H; y++ {
		for x := r.X; x < r.X+r.W; x++ {
			lo, hi := rgb565(f.Pix[y*f.W+x])
			o := (y*ui.ScreenW + x) * 2
			fb[o], fb[o+1] = lo, hi
		}
	}
	return nil
}

func (p *Panel) Init(f *ui.Frame) error {
	if err := p.blit(f, ui.Rect{W: ui.ScreenW, H: ui.ScreenH}); err != nil {
		return err
	}
	m, err := EncodeRefreshMode(p.Mode)
	if err != nil {
		return err
	}
	if err := p.L.Send(m); err != nil {
		return err
	}
	return p.L.Send(EncodeUpdateAll())
}

func (p *Panel) Partial(f *ui.Frame, r ui.Rect) error {
	m, err := EncodeUpdatePartial(r)
	if err != nil {
		return err
	}
	if err := p.blit(f, r); err != nil {
		return err
	}
	return p.L.Send(m)
}

// Clean requests the panel's real full clean refresh (AppLoad emits
// requestFullRefresh, which calls xochitl's own full-refresh routine).
func (p *Panel) Clean() error { return p.L.Send(EncodeFullRefresh()) }
