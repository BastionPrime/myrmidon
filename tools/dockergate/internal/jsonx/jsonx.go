// Package jsonx is the strict JSON parser of dockergate. It exists because
// encoding/json is deliberately lenient (case-insensitive keys, last duplicate
// wins, lone surrogates repaired, NaN-free but permissive numbers): a body that
// a lenient parser accepts is a body that two parsers can read differently. The
// parser here accepts the small, exact subset that the driver produces and
// keeps the member order, so that a body can be rebuilt and compared byte for
// byte.
//
// What it accepts: UTF-8 without a BOM, exactly one value followed only by
// whitespace, objects without duplicate keys (also not by case), integers with
// an absolute value of at most 2^53 and no fraction or exponent, strings
// without NUL and without lone surrogates. null is refused. Depth and string
// length are bounded.
package jsonx

import (
	"unicode/utf8"

	"strings"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// Limits of the parser (spec 7.1).
const (
	MaxDepth  = 4
	MaxString = 16 * 1024
	// MaxInt is the largest absolute value of an integer: 2^53, the largest
	// range in which a JavaScript number is exact.
	MaxInt = int64(1) << 53
)

// Kind is the type of a parsed value.
type Kind uint8

const (
	KindObject Kind = iota + 1
	KindArray
	KindString
	KindInt
	KindBool
)

func (k Kind) String() string {
	switch k {
	case KindObject:
		return "object"
	case KindArray:
		return "array"
	case KindString:
		return "string"
	case KindInt:
		return "integer"
	case KindBool:
		return "boolean"
	}
	return "unknown"
}

// Member is a key of an object with its value, in the order of the input.
type Member struct {
	Key string
	Val *Value
}

// Value is a parsed JSON value.
type Value struct {
	Kind    Kind
	S       string
	N       int64
	B       bool
	Members []Member
	Elems   []*Value
}

// Get returns the member with exactly this key, or nil.
func (v *Value) Get(key string) *Value {
	if v == nil || v.Kind != KindObject {
		return nil
	}
	for i := range v.Members {
		if v.Members[i].Key == key {
			return v.Members[i].Val
		}
	}
	return nil
}

// Parse parses data. The error carries the reason code and, for a value
// problem, no value from the input.
func Parse(data []byte) (*Value, *deny.Error) {
	if len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
		return nil, deny.New(deny.JSONSyntax).WithDetail("bom")
	}
	if !utf8.Valid(data) {
		return nil, deny.New(deny.JSONSyntax).WithDetail("utf8")
	}
	p := &parser{b: data}
	p.ws()
	v, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(p.b) {
		return nil, deny.New(deny.JSONSyntax).WithDetail("trailing_data")
	}
	return v, nil
}

type parser struct {
	b []byte
	i int
}

func syntax(detail string) *deny.Error { return deny.New(deny.JSONSyntax).WithDetail(detail) }

func (p *parser) ws() {
	for p.i < len(p.b) {
		switch p.b[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

// value parses a value; depth is the number of containers around it.
func (p *parser) value(depth int) (*Value, *deny.Error) {
	if p.i >= len(p.b) {
		return nil, syntax("eof")
	}
	switch c := p.b[p.i]; {
	case c == '{':
		return p.object(depth + 1)
	case c == '[':
		return p.array(depth + 1)
	case c == '"':
		s, err := p.str()
		if err != nil {
			return nil, err
		}
		return &Value{Kind: KindString, S: s}, nil
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case c == 't':
		if p.lit("true") {
			return &Value{Kind: KindBool, B: true}, nil
		}
		return nil, syntax("literal")
	case c == 'f':
		if p.lit("false") {
			return &Value{Kind: KindBool}, nil
		}
		return nil, syntax("literal")
	case c == 'n':
		if p.lit("null") {
			return nil, deny.New(deny.JSONType).WithDetail("null")
		}
		return nil, syntax("literal")
	}
	return nil, syntax("value")
}

func (p *parser) lit(s string) bool {
	if len(p.b)-p.i >= len(s) && string(p.b[p.i:p.i+len(s)]) == s {
		p.i += len(s)
		return true
	}
	return false
}

func (p *parser) number() (*Value, *deny.Error) {
	start := p.i
	neg := false
	if p.b[p.i] == '-' {
		neg = true
		p.i++
	}
	if p.i >= len(p.b) || p.b[p.i] < '0' || p.b[p.i] > '9' {
		return nil, syntax("number")
	}
	if p.b[p.i] == '0' {
		p.i++
		// "01" and "-01" are not JSON.
		if p.i < len(p.b) && p.b[p.i] >= '0' && p.b[p.i] <= '9' {
			return nil, syntax("leading_zero")
		}
	} else {
		for p.i < len(p.b) && p.b[p.i] >= '0' && p.b[p.i] <= '9' {
			p.i++
		}
	}
	if p.i < len(p.b) && (p.b[p.i] == '.' || p.b[p.i] == 'e' || p.b[p.i] == 'E') {
		// A well-formed but non-integer number: a type problem, not a syntax one.
		return nil, deny.New(deny.JSONType).WithDetail("non_integer")
	}
	digits := p.b[start:p.i]
	if neg {
		digits = digits[1:]
	}
	if len(digits) > 16 {
		return nil, deny.New(deny.JSONValue).WithDetail("integer_range")
	}
	var n int64
	for _, d := range digits {
		n = n*10 + int64(d-'0')
	}
	if n > MaxInt {
		return nil, deny.New(deny.JSONValue).WithDetail("integer_range")
	}
	if neg {
		n = -n
	}
	return &Value{Kind: KindInt, N: n}, nil
}

func (p *parser) str() (string, *deny.Error) {
	// p.b[p.i] == '"'
	p.i++
	var sb strings.Builder
	for {
		if p.i >= len(p.b) {
			return "", syntax("string_eof")
		}
		c := p.b[p.i]
		switch {
		case c == '"':
			p.i++
			return sb.String(), nil
		case c < 0x20:
			return "", syntax("control_char")
		case c == '\\':
			p.i++
			if p.i >= len(p.b) {
				return "", syntax("string_eof")
			}
			e := p.b[p.i]
			p.i++
			switch e {
			case '"', '\\', '/':
				sb.WriteByte(e)
			case 'b':
				sb.WriteByte('\b')
			case 'f':
				sb.WriteByte('\f')
			case 'n':
				sb.WriteByte('\n')
			case 'r':
				sb.WriteByte('\r')
			case 't':
				sb.WriteByte('\t')
			case 'u':
				r, err := p.unicode()
				if err != nil {
					return "", err
				}
				sb.WriteRune(r)
			default:
				return "", syntax("escape")
			}
		default:
			sb.WriteByte(c)
			p.i++
		}
		if sb.Len() > MaxString {
			return "", deny.New(deny.JSONValue).WithDetail("string_length")
		}
	}
}

func (p *parser) hex4() (rune, bool) {
	if len(p.b)-p.i < 4 {
		return 0, false
	}
	var r rune
	for k := 0; k < 4; k++ {
		c := p.b[p.i+k]
		var d byte
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, false
		}
		r = r<<4 | rune(d)
	}
	p.i += 4
	return r, true
}

// unicode parses the four hex digits after \u (and a following \uXXXX for a
// surrogate pair). NUL and lone surrogates are refused.
func (p *parser) unicode() (rune, *deny.Error) {
	r, ok := p.hex4()
	if !ok {
		return 0, syntax("unicode_escape")
	}
	switch {
	case r == 0:
		return 0, syntax("nul")
	case r >= 0xD800 && r <= 0xDBFF:
		if len(p.b)-p.i >= 2 && p.b[p.i] == '\\' && p.b[p.i+1] == 'u' {
			p.i += 2
			lo, ok := p.hex4()
			if !ok {
				return 0, syntax("unicode_escape")
			}
			if lo >= 0xDC00 && lo <= 0xDFFF {
				return (r-0xD800)<<10 | (lo - 0xDC00) + 0x10000, nil
			}
		}
		return 0, syntax("lone_surrogate")
	case r >= 0xDC00 && r <= 0xDFFF:
		return 0, syntax("lone_surrogate")
	}
	return r, nil
}

func (p *parser) array(depth int) (*Value, *deny.Error) {
	if depth > MaxDepth {
		return nil, deny.New(deny.JSONValue).WithDetail("depth")
	}
	p.i++ // [
	v := &Value{Kind: KindArray}
	p.ws()
	if p.i < len(p.b) && p.b[p.i] == ']' {
		p.i++
		return v, nil
	}
	for {
		p.ws()
		e, err := p.value(depth)
		if err != nil {
			return nil, err
		}
		v.Elems = append(v.Elems, e)
		p.ws()
		if p.i >= len(p.b) {
			return nil, syntax("eof")
		}
		switch p.b[p.i] {
		case ',':
			p.i++
		case ']':
			p.i++
			return v, nil
		default:
			return nil, syntax("array")
		}
	}
}

func (p *parser) object(depth int) (*Value, *deny.Error) {
	if depth > MaxDepth {
		return nil, deny.New(deny.JSONValue).WithDetail("depth")
	}
	p.i++ // {
	v := &Value{Kind: KindObject}
	seen := map[string]struct{}{}
	p.ws()
	if p.i < len(p.b) && p.b[p.i] == '}' {
		p.i++
		return v, nil
	}
	for {
		p.ws()
		if p.i >= len(p.b) || p.b[p.i] != '"' {
			return nil, syntax("key")
		}
		k, err := p.str()
		if err != nil {
			return nil, err
		}
		// A duplicate is a duplicate also when it differs only in case: a parser
		// that folds case (encoding/json does) would merge the two.
		folded := strings.ToLower(k)
		if _, dup := seen[folded]; dup {
			return nil, deny.New(deny.JSONDuplicateKey).WithDetail("duplicate")
		}
		seen[folded] = struct{}{}
		p.ws()
		if p.i >= len(p.b) || p.b[p.i] != ':' {
			return nil, syntax("colon")
		}
		p.i++
		p.ws()
		val, err := p.value(depth)
		if err != nil {
			return nil, err
		}
		v.Members = append(v.Members, Member{Key: k, Val: val})
		p.ws()
		if p.i >= len(p.b) {
			return nil, syntax("eof")
		}
		switch p.b[p.i] {
		case ',':
			p.i++
		case '}':
			p.i++
			return v, nil
		default:
			return nil, syntax("object")
		}
	}
}
