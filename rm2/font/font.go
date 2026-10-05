// Package font exposes GNU Unifont 16.0.04 (BMP, 16px bitmap) as 1-bit glyphs.
// The .hex.gz file is the unmodified upstream build; see rm2/DEPENDENCIES.json.
package font

import (
	"bufio"
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/hex"
	"fmt"
	"strconv"
	"sync"
)

//go:embed unifont-16.0.04.hex.gz
var hexGz []byte

// Glyph is a 16-row bitmap, 8 (Wide=false) or 16 (Wide=true) pixels wide, MSB first.
type Glyph struct {
	Wide bool
	Rows []byte // 16 bytes (narrow) or 32 bytes (wide)
}

const Height = 16

var (
	once   sync.Once
	glyphs map[rune]Glyph
	loadEr error
)

func load() {
	glyphs = make(map[rune]Glyph, 60000)
	zr, err := gzip.NewReader(bytes.NewReader(hexGz))
	if err != nil {
		loadEr = fmt.Errorf("unifont: %w", err)
		return
	}
	sc := bufio.NewScanner(zr)
	for sc.Scan() {
		line := sc.Bytes()
		i := bytes.IndexByte(line, ':')
		if i < 0 {
			continue
		}
		cp, err := strconv.ParseUint(string(line[:i]), 16, 32)
		if err != nil {
			loadEr = fmt.Errorf("unifont: bad codepoint %q", line[:i])
			return
		}
		rows, err := hex.DecodeString(string(line[i+1:]))
		if err != nil || (len(rows) != 16 && len(rows) != 32) {
			loadEr = fmt.Errorf("unifont: bad glyph for U+%04X", cp)
			return
		}
		glyphs[rune(cp)] = Glyph{Wide: len(rows) == 32, Rows: rows}
	}
	if err := sc.Err(); err != nil {
		loadEr = fmt.Errorf("unifont: %w", err)
	}
}

// Check reports whether the embedded font decoded; callers must fail loudly on error.
func Check() error {
	once.Do(load)
	if loadEr != nil {
		return loadEr
	}
	if len(glyphs) < 50000 {
		return fmt.Errorf("unifont: only %d glyphs decoded", len(glyphs))
	}
	return nil
}

// Lookup returns the glyph for r, or the replacement glyph U+FFFD when the font has none.
func Lookup(r rune) Glyph {
	once.Do(load)
	if g, ok := glyphs[r]; ok {
		return g
	}
	return glyphs[0xFFFD]
}

// Cols is the display width of r in half-width cells (1 or 2).
func Cols(r rune) int {
	if Lookup(r).Wide {
		return 2
	}
	return 1
}
