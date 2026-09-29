package ustar

import (
	"bytes"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/jsonx"
)

// Limits (spec 8.7).
const (
	MaxArchive = 16 << 20
	MaxEntries = 2000
	MaxFile    = 1 << 20
	// MaxApplied is the size limit of applied.json.
	MaxApplied = 64 << 10
)

const (
	nextPrefix  = ".myrmidon-next-"
	applyPrefix = ".myrmidon-apply-"
	reserved    = ".myrmidon"
	// HermesMount is the only mount point whose archive carries the apply
	// metadata.
	HermesMount = "/data/hermes"
)

// Result is a checked archive.
type Result struct {
	// Canonical is the rebuilt archive: the bytes that go to the daemon.
	Canonical []byte
	Entries   int
}

// Validate checks an archive that is PUT to mount (one of /data/hermes,
// /workspace, /scratch) of a helper whose apply script carries the nonce.
func Validate(archive []byte, mount, nonce string) (*Result, *deny.Error) {
	if len(archive) > MaxArchive {
		return nil, deny.New(deny.BodyTooLarge)
	}
	if len(archive) < 2*blockSize || len(archive)%blockSize != 0 {
		return nil, syntax("length")
	}

	var (
		entries  []Entry
		dirs     = map[string]bool{}
		files    = map[string]bool{}
		seenFile bool
		off      int
		ended    bool
	)
	for off < len(archive) {
		h := archive[off : off+blockSize]
		if allZero(h) {
			// The end: exactly two zero blocks, and nothing after them.
			if off+2*blockSize != len(archive) || !allZero(archive[off:]) {
				return nil, syntax("end")
			}
			ended = true
			break
		}
		if len(entries) >= MaxEntries {
			return nil, deny.New(deny.TarTooLarge).WithDetail("entries")
		}
		e, size, derr := parseHeader(h)
		if derr != nil {
			return nil, derr
		}
		dataEnd := off + blockSize + size
		padded := off + blockSize + (size+blockSize-1)/blockSize*blockSize
		if padded > len(archive) {
			return nil, syntax("truncated")
		}
		e.Data = append([]byte(nil), archive[off+blockSize:dataEnd]...)
		off = padded

		if derr := checkPath(e, mount, nonce); derr != nil {
			return nil, derr
		}
		// Directories first, then files, no duplicates, parents before children.
		if e.Dir && seenFile {
			return nil, deny.New(deny.TarOrder).WithDetail("dir_after_file")
		}
		if dirs[e.Path] || files[e.Path] {
			return nil, deny.New(deny.TarOrder).WithDetail("duplicate")
		}
		if i := strings.LastIndexByte(e.Path, '/'); i >= 0 && !dirs[e.Path[:i]] {
			return nil, deny.New(deny.TarOrder).WithDetail("parent_missing")
		}
		if e.Dir {
			dirs[e.Path] = true
		} else {
			files[e.Path] = true
			seenFile = true
		}
		entries = append(entries, *e)
	}
	if !ended {
		return nil, syntax("no_end")
	}

	if derr := checkContent(entries, dirs, files, mount, nonce); derr != nil {
		return nil, derr
	}

	canonical, err := Build(entries)
	if err != nil {
		return nil, deny.New(deny.TarPath).WithDetail("too_long")
	}
	if !bytes.Equal(canonical, archive) {
		return nil, deny.New(deny.TarNotCanonical)
	}
	return &Result{Canonical: canonical, Entries: len(entries)}, nil
}

func syntax(detail string) *deny.Error { return deny.New(deny.TarSyntax).WithDetail(detail) }

func allZero(b []byte) bool {
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}

// field returns the value of a numeric field made of exactly digits octal
// digits and a NUL. Base-256 (the high bit of the first byte) and anything else
// is refused.
func octal(b []byte, digits int) (int64, bool) {
	if b[0]&0x80 != 0 || b[digits] != 0 {
		return 0, false
	}
	var v int64
	for _, c := range b[:digits] {
		if c < '0' || c > '7' {
			return 0, false
		}
		v = v<<3 | int64(c-'0')
	}
	return v, true
}

func cstring(b []byte) []byte {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		return b[:i]
	}
	return b
}

// parseHeader checks one header block and returns the entry (without data) and
// the size of the content.
func parseHeader(h []byte) (*Entry, int, *deny.Error) {
	if string(h[257:263]) != "ustar\x00" || string(h[263:265]) != "00" {
		return nil, 0, syntax("magic")
	}
	// The checksum: six octal digits, NUL, space; the sum is taken with the
	// field read as eight spaces.
	sumField := h[148:156]
	stored, ok := int64(0), sumField[6] == 0 && sumField[7] == ' '
	for _, c := range sumField[:6] {
		if c < '0' || c > '7' {
			ok = false
			break
		}
		stored = stored<<3 | int64(c-'0')
	}
	if !ok {
		return nil, 0, syntax("checksum_field")
	}
	var sum int64
	for i, c := range h {
		if i >= 148 && i < 156 {
			c = ' '
		}
		sum += int64(c)
	}
	if sum != stored {
		return nil, 0, syntax("checksum")
	}

	var dir bool
	switch h[156] {
	case typeFile:
	case typeDir:
		dir = true
	default:
		return nil, 0, deny.New(deny.TarType)
	}

	mode, ok1 := octal(h[100:108], 7)
	uid, ok2 := octal(h[108:116], 7)
	gid, ok3 := octal(h[116:124], 7)
	size, ok4 := octal(h[124:136], 11)
	mtime, ok5 := octal(h[136:148], 11)
	if !(ok1 && ok2 && ok3 && ok4 && ok5) {
		return nil, 0, syntax("numeric")
	}
	if uid != Owner || gid != Owner {
		return nil, 0, deny.New(deny.TarOwner)
	}
	switch {
	case dir && mode != 0o700, !dir && mode != 0o600 && mode != 0o644:
		return nil, 0, deny.New(deny.TarMode)
	}
	if dir && size != 0 {
		return nil, 0, syntax("dir_size")
	}
	if size > MaxFile {
		return nil, 0, deny.New(deny.TarTooLarge).WithDetail("file")
	}
	// linkname, devmajor and devminor are empty; uname and gname are the fixed
	// name of the writer.
	if !allZero(h[157:257]) {
		return nil, 0, syntax("linkname")
	}
	if dm, ok := octal(h[329:337], 7); !ok || dm != 0 {
		return nil, 0, syntax("devmajor")
	}
	if dm, ok := octal(h[337:345], 7); !ok || dm != 0 {
		return nil, 0, syntax("devminor")
	}
	if string(cstring(h[265:297])) != "myrmidon" || string(cstring(h[297:329])) != "myrmidon" {
		return nil, 0, syntax("owner_name")
	}

	name := cstring(h[0:nameMax])
	prefix := cstring(h[345 : 345+prefixMax])
	full := string(name)
	if len(prefix) > 0 {
		full = string(prefix) + "/" + full
	}
	if !utf8.ValidString(full) {
		return nil, 0, deny.New(deny.TarPath).WithDetail("utf8")
	}
	if dir != strings.HasSuffix(full, "/") {
		return nil, 0, deny.New(deny.TarPath).WithDetail("dir_slash")
	}
	full = strings.TrimSuffix(full, "/")
	return &Entry{Path: full, Dir: dir, Mode: uint32(mode), MTime: mtime}, int(size), nil
}

// relOK applies the rules of a path inside a volume (template.ts): not empty,
// no empty, "." or ".." segment, no segment starting with ".myrmidon", no
// backslash, no control character or DEL, no leading "/".
func relOK(rel string) bool {
	if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, `\`) {
		return false
	}
	for i := 0; i < len(rel); i++ {
		if rel[i] < 0x20 || rel[i] == 0x7f {
			return false
		}
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, reserved) {
			return false
		}
	}
	return true
}

// checkPath applies the path rules of spec 8.4 to one entry.
func checkPath(e *Entry, mount, nonce string) *deny.Error {
	first, rest, _ := strings.Cut(e.Path, "/")
	switch {
	case strings.HasPrefix(first, nextPrefix):
		if first[len(nextPrefix):] != nonce {
			return deny.New(deny.TarNonce)
		}
		if rest != "" && !relOK(rest) {
			return deny.New(deny.TarPath).WithDetail("rel")
		}
	case strings.HasPrefix(first, applyPrefix):
		if mount != HermesMount {
			return deny.New(deny.TarPath).WithDetail("apply_outside_hermes")
		}
		if first[len(applyPrefix):] != nonce {
			return deny.New(deny.TarNonce)
		}
		switch {
		case e.Dir && rest == "":
		case !e.Dir && (rest == "applied.json" || rest == "remove.list"):
		default:
			return deny.New(deny.TarPath).WithDetail("apply_entry")
		}
	default:
		return deny.New(deny.TarPath).WithDetail("outside_staging")
	}
	return nil
}

var removeLineRe = regexp.MustCompile(`^(hermes|workspace|scratch)/(.+)$`)

// checkContent checks what an archive must contain and the two service files.
func checkContent(entries []Entry, dirs, files map[string]bool, mount, nonce string) *deny.Error {
	if !dirs[nextPrefix+nonce] {
		return deny.New(deny.TarContent).WithDetail("staging_dir")
	}
	if mount != HermesMount {
		return nil
	}
	apply := applyPrefix + nonce
	if !dirs[apply] || !files[apply+"/applied.json"] || !files[apply+"/remove.list"] {
		return deny.New(deny.TarContent).WithDetail("apply_files")
	}
	for i := range entries {
		e := &entries[i]
		switch e.Path {
		case apply + "/applied.json":
			if derr := checkApplied(e.Data); derr != nil {
				return derr
			}
		case apply + "/remove.list":
			if derr := checkRemoveList(e.Data); derr != nil {
				return derr
			}
		}
	}
	return nil
}

func content(detail string) *deny.Error { return deny.New(deny.TarContent).WithDetail(detail) }

// checkApplied requires an object with exactly the string keys restartHash and
// filesHash and the string array files. Its content is not rebuilt: the
// marker is data the board writes for itself.
func checkApplied(data []byte) *deny.Error {
	if len(data) > MaxApplied {
		return content("applied_size")
	}
	v, derr := jsonx.Parse(data)
	if derr != nil || v.Kind != jsonx.KindObject || len(v.Members) != 3 {
		return content("applied_json")
	}
	for _, key := range []string{"restartHash", "filesHash"} {
		if m := v.Get(key); m == nil || m.Kind != jsonx.KindString {
			return content("applied_keys")
		}
	}
	files := v.Get("files")
	if files == nil || files.Kind != jsonx.KindArray {
		return content("applied_keys")
	}
	for _, f := range files.Elems {
		if f.Kind != jsonx.KindString {
			return content("applied_files")
		}
	}
	return nil
}

// checkRemoveList: empty, or lines "hermes|workspace|scratch/<rel>" each ended
// by a newline.
func checkRemoveList(data []byte) *deny.Error {
	if len(data) == 0 {
		return nil
	}
	if data[len(data)-1] != '\n' {
		return content("remove_newline")
	}
	for _, line := range strings.Split(string(data[:len(data)-1]), "\n") {
		m := removeLineRe.FindStringSubmatch(line)
		if m == nil || !relOK(m[2]) {
			return content("remove_line")
		}
	}
	return nil
}
