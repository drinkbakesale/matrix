package firstrun

import (
	"bytes"
	"fmt"
	"os"
	"strings"
)

// WritePDF writes the report as a plain one-page A5 PDF that the stock
// reMarkable interface can open after a normal USB document import. It is the
// way a refusal reaches the tablet's screen when the display backend itself
// cannot safely be used. Text is stored uncompressed.
func WritePDF(path string, lines []string) error {
	esc := strings.NewReplacer(`\`, `\\`, `(`, `\(`, `)`, `\)`)
	var content bytes.Buffer
	content.WriteString("BT\n/F1 11 Tf\n14 TL\n36 560 Td\n")
	for _, l := range lines {
		for _, part := range wrap(ascii(l), 62) {
			fmt.Fprintf(&content, "(%s) Tj\nT*\n", esc.Replace(part))
		}
	}
	content.WriteString("ET\n")

	objs := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", content.Len(), content.String()),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
	}
	var out bytes.Buffer
	out.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objs))
	for i, o := range objs {
		offsets[i] = out.Len()
		fmt.Fprintf(&out, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	xref := out.Len()
	fmt.Fprintf(&out, "xref\n0 %d\n0000000000 65535 f \n", len(objs)+1)
	for _, off := range offsets {
		fmt.Fprintf(&out, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&out, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xref)
	return os.WriteFile(path, out.Bytes(), 0o644)
}

func ascii(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '—' || r == '–':
			b.WriteByte('-')
		case r < 32 || r > 126:
			b.WriteByte('?')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func wrap(s string, cols int) []string {
	if s == "" {
		return []string{""}
	}
	var out []string
	line := ""
	for _, w := range strings.Fields(s) {
		for len(w) > cols {
			if line != "" {
				out = append(out, line)
				line = ""
			}
			out = append(out, w[:cols])
			w = w[cols:]
		}
		if line == "" {
			line = w
		} else if len(line)+1+len(w) <= cols {
			line += " " + w
		} else {
			out = append(out, line)
			line = w
		}
	}
	return append(out, line)
}
