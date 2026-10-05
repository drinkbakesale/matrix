package ui

import "matrixrm2/font"

// Rect is x, y, width, height in native framebuffer pixels.
type Rect struct{ X, Y, W, H int }

func (r Rect) Empty() bool { return r.W <= 0 || r.H <= 0 }

func (r Rect) Contains(x, y int) bool {
	return x >= r.X && y >= r.Y && x < r.X+r.W && y < r.Y+r.H
}

func (r Rect) Intersect(o Rect) Rect {
	x0, y0 := max(r.X, o.X), max(r.Y, o.Y)
	x1, y1 := min(r.X+r.W, o.X+o.W), min(r.Y+r.H, o.Y+o.H)
	if x1 <= x0 || y1 <= y0 {
		return Rect{}
	}
	return Rect{x0, y0, x1 - x0, y1 - y0}
}

func (r Rect) List() []int { return []int{r.X, r.Y, r.W, r.H} }

// Frame is a monochrome frame: one byte per pixel, 0 = black ink, 255 = white.
type Frame struct {
	W, H int
	Pix  []byte
}

func NewFrame(w, h int) *Frame {
	f := &Frame{W: w, H: h, Pix: make([]byte, w*h)}
	for i := range f.Pix {
		f.Pix[i] = 255
	}
	return f
}

const (
	Scale  = 2                   // Unifont is drawn at 2x: 32px tall, 16px per half-width cell
	CellW  = 8 * Scale           // half-width cell
	GlyphH = font.Height * Scale // glyph height
	LineH  = GlyphH + 6          // line pitch
)

// canvas draws into a frame, clipped to one region. Nothing can be drawn
// outside clip, so a region render cannot touch another region's pixels.
type canvas struct {
	f    *Frame
	clip Rect
}

func (c *canvas) set(x, y int, v byte) {
	if c.clip.Contains(x, y) {
		c.f.Pix[y*c.f.W+x] = v
	}
}

func (c *canvas) fill(r Rect, v byte) {
	r = r.Intersect(c.clip)
	for y := r.Y; y < r.Y+r.H; y++ {
		row := c.f.Pix[y*c.f.W+r.X : y*c.f.W+r.X+r.W]
		for i := range row {
			row[i] = v
		}
	}
}

// text draws s on one line starting at x,y and returns the x after the last
// glyph. ink is the pixel value for set bits (0 black on white, 255 for
// inverted text on a black box).
func (c *canvas) text(x, y int, s string, ink byte) int {
	for _, r := range s {
		g := font.Lookup(r)
		wbytes := 1
		if g.Wide {
			wbytes = 2
		}
		for row := 0; row < font.Height; row++ {
			for b := 0; b < wbytes*8; b++ {
				if g.Rows[row*wbytes+b/8]&(0x80>>(b%8)) == 0 {
					continue
				}
				for dy := 0; dy < Scale; dy++ {
					for dx := 0; dx < Scale; dx++ {
						c.set(x+b*Scale+dx, y+row*Scale+dy, ink)
					}
				}
			}
		}
		x += wbytes * 8 * Scale
	}
	return x
}

func textCols(s string) int {
	n := 0
	for _, r := range s {
		n += font.Cols(r)
	}
	return n
}

// diffBox returns the bounding box of pixels that differ between a and b inside r.
func diffBox(a, b *Frame, r Rect) Rect {
	x0, y0, x1, y1 := r.X+r.W, r.Y+r.H, -1, -1
	for y := r.Y; y < r.Y+r.H; y++ {
		ra := a.Pix[y*a.W+r.X : y*a.W+r.X+r.W]
		rb := b.Pix[y*b.W+r.X : y*b.W+r.X+r.W]
		for i := range ra {
			if ra[i] != rb[i] {
				x := r.X + i
				if x < x0 {
					x0 = x
				}
				if x > x1 {
					x1 = x
				}
				if y < y0 {
					y0 = y
				}
				if y > y1 {
					y1 = y
				}
			}
		}
	}
	if x1 < 0 {
		return Rect{}
	}
	return Rect{x0, y0, x1 - x0 + 1, y1 - y0 + 1}
}

func copyRect(dst, src *Frame, r Rect) {
	for y := r.Y; y < r.Y+r.H; y++ {
		copy(dst.Pix[y*dst.W+r.X:y*dst.W+r.X+r.W], src.Pix[y*src.W+r.X:y*src.W+r.X+r.W])
	}
}
