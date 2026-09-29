package policy

import "strconv"

// writer builds a JSON text the way JSON.stringify does: no whitespace, the
// keys in the order the caller writes them, no HTML escaping and no trailing
// newline. The canonical form of a create body is what the driver's
// JSON.stringify produces for the driver's own object literal; a body that
// differs in a single byte from the rebuild is refused.
type writer struct{ b []byte }

func (w *writer) raw(s string) *writer { w.b = append(w.b, s...); return w }

func (w *writer) int(n int64) *writer {
	w.b = strconv.AppendInt(w.b, n, 10)
	return w
}

// str writes a JSON string with the escaping of JSON.stringify: the quote and
// the backslash, \b \f \n \r \t, other control characters below 0x20 as
// lowercase \u00xx, everything else as it is (U+2028, U+2029 and DEL too).
func (w *writer) str(s string) *writer {
	const hex = "0123456789abcdef"
	w.b = append(w.b, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			w.b = append(w.b, '\\', '"')
		case '\\':
			w.b = append(w.b, '\\', '\\')
		case '\b':
			w.b = append(w.b, '\\', 'b')
		case '\f':
			w.b = append(w.b, '\\', 'f')
		case '\n':
			w.b = append(w.b, '\\', 'n')
		case '\r':
			w.b = append(w.b, '\\', 'r')
		case '\t':
			w.b = append(w.b, '\\', 't')
		default:
			if c < 0x20 {
				w.b = append(w.b, '\\', 'u', '0', '0', hex[c>>4], hex[c&15])
			} else {
				w.b = append(w.b, c)
			}
		}
	}
	w.b = append(w.b, '"')
	return w
}

// strs writes an array of strings.
func (w *writer) strs(list []string) *writer {
	w.b = append(w.b, '[')
	for i, s := range list {
		if i > 0 {
			w.b = append(w.b, ',')
		}
		w.str(s)
	}
	w.b = append(w.b, ']')
	return w
}

// Quote returns s as a JSON string literal (exported for the trimmers that
// build responses, and for tests).
func Quote(s string) string {
	var w writer
	return string(w.str(s).b)
}
