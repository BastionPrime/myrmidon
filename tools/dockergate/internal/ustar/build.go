// Package ustar checks the tar archive that the board PUTs into a helper
// container (route A5) and rebuilds it. It mirrors, and does not share code
// with, server/src/myrmidon/bot-containers/ustar.ts: the strict subset that
// that writer produces is the only subset that passes. An archive is parsed
// field by field, checked against the rules of spec section 8, rebuilt from the
// checked fields, and refused unless the rebuild equals the input byte for
// byte. The daemon receives the rebuilt copy.
package ustar

import (
	"errors"
	"strconv"
	"strings"
)

const (
	blockSize = 512
	nameMax   = 100
	prefixMax = 155

	typeFile = '0'
	typeDir  = '5'
)

// Owner is the uid and gid of every entry.
const Owner = 10001

// Entry is one checked entry of an archive.
type Entry struct {
	// Path is relative, without a leading or trailing "/".
	Path  string
	Dir   bool
	Mode  uint32
	MTime int64
	Data  []byte
}

var errTooLong = errors.New("path too long for a ustar header")

// splitPath splits a path into the 100-byte name and the 155-byte prefix at a
// "/" boundary, the way ustar.ts does: the whole path in name when it fits
// (the "/" of a directory counted), else the longest prefix for which both
// halves fit.
func splitPath(path string, dir bool) (name, prefix string, err error) {
	suffix := ""
	if dir {
		suffix = "/"
	}
	full := path + suffix
	if len(full) <= nameMax {
		return full, "", nil
	}
	parts := strings.Split(path, "/")
	for i := len(parts) - 1; i > 0; i-- {
		p := strings.Join(parts[:i], "/")
		n := strings.Join(parts[i:], "/") + suffix
		if len(p) <= prefixMax && len(n) <= nameMax {
			return n, p, nil
		}
	}
	return "", "", errTooLong
}

func putOctal(dst []byte, v int64, digits int) {
	s := strconv.FormatInt(v, 8)
	for len(s) < digits {
		s = "0" + s
	}
	copy(dst, s)
	dst[digits] = 0
}

func header(e *Entry, name, prefix string) []byte {
	b := make([]byte, blockSize)
	copy(b[0:nameMax], name)
	putOctal(b[100:108], int64(e.Mode&0o7777), 7)
	putOctal(b[108:116], Owner, 7)
	putOctal(b[116:124], Owner, 7)
	putOctal(b[124:136], int64(len(e.Data)), 11)
	putOctal(b[136:148], e.MTime, 11)
	for i := 148; i < 156; i++ {
		b[i] = ' '
	}
	if e.Dir {
		b[156] = typeDir
	} else {
		b[156] = typeFile
	}
	copy(b[257:262], "ustar")
	copy(b[263:265], "00")
	copy(b[265:297], "myrmidon")
	copy(b[297:329], "myrmidon")
	putOctal(b[329:337], 0, 7)
	putOctal(b[337:345], 0, 7)
	copy(b[345:345+prefixMax], prefix)

	sum := 0
	for _, c := range b {
		sum += int(c)
	}
	s := strconv.FormatInt(int64(sum), 8)
	for len(s) < 6 {
		s = "0" + s
	}
	for i := 148; i < 156; i++ {
		b[i] = ' '
	}
	copy(b[148:154], s)
	b[154] = 0
	return b
}

// Build writes the archive of the entries in the given order: header, content
// padded to a block, and at the end the two zero blocks.
func Build(entries []Entry) ([]byte, error) {
	var out []byte
	for i := range entries {
		e := &entries[i]
		name, prefix, err := splitPath(e.Path, e.Dir)
		if err != nil {
			return nil, err
		}
		out = append(out, header(e, name, prefix)...)
		out = append(out, e.Data...)
		if r := len(e.Data) % blockSize; r != 0 {
			out = append(out, make([]byte, blockSize-r)...)
		}
	}
	return append(out, make([]byte, 2*blockSize)...), nil
}
