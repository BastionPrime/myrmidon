package ustar_test

import (
	"bytes"
	"strconv"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fixture"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/ustar"
)

const (
	nonce   = "0123456789abcdef"
	mtime   = 1780000000
	applied = `{"restartHash":"r1","filesHash":"f1","files":["a"]}`
	hermes  = ustar.HermesMount
)

func dirE(p string) ustar.Entry {
	return ustar.Entry{Path: p, Dir: true, Mode: 0o700, MTime: mtime}
}

func fileE(p, data string) ustar.Entry {
	return ustar.Entry{Path: p, Mode: 0o600, MTime: mtime, Data: []byte(data)}
}

func next(n string) string  { return ".myrmidon-next-" + n }
func apply(n string) string { return ".myrmidon-apply-" + n }

// hermesEntries is a valid archive for /data/hermes.
func hermesEntries(n string) []ustar.Entry {
	return []ustar.Entry{
		dirE(next(n)), dirE(next(n) + "/skills"), dirE(apply(n)),
		fileE(next(n)+"/config.yaml", "a: 1\n"),
		fileE(next(n)+"/skills/one.md", "one\n"),
		fileE(apply(n)+"/applied.json", applied),
		fileE(apply(n)+"/remove.list", "hermes/old.txt\nworkspace/x/y\n"),
	}
}

// plainEntries is a valid archive for /workspace or /scratch.
func plainEntries(n string) []ustar.Entry {
	return []ustar.Entry{dirE(next(n)), dirE(next(n) + "/d"), fileE(next(n)+"/d/f.txt", "f")}
}

func build(t *testing.T, e []ustar.Entry) []byte {
	t.Helper()
	b, err := ustar.Build(e)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return b
}

func wantCode(t *testing.T, res *ustar.Result, err *deny.Error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("accepted (%d entries), want %s", res.Entries, code)
	}
	if err.Code != code {
		t.Fatalf("denied as %s (%s), want %s", err.Code, err.Detail, code)
	}
}

func wantOK(t *testing.T, archive []byte, mount, n string) {
	t.Helper()
	res, err := ustar.Validate(archive, mount, n)
	if err != nil {
		t.Fatalf("denied: %s (%s)", err.Code, err.Detail)
	}
	if !bytes.Equal(res.Canonical, archive) {
		t.Fatal("the canonical archive differs from the input")
	}
}

// --- the recorded archives of the real writer ----------------------------------

func TestRecordedArchives(t *testing.T) {
	m := fixture.Load(t)
	if len(m.Archives) == 0 {
		t.Fatal("no archives recorded")
	}
	for _, a := range m.Archives {
		t.Run(a.ID+a.MountPath, func(t *testing.T) {
			archive := fixture.ArchiveBytes(t, a)
			res, err := ustar.Validate(archive, a.MountPath, a.Nonce)
			if err != nil {
				t.Fatalf("denied: %s (%s)", err.Code, err.Detail)
			}
			if !bytes.Equal(res.Canonical, archive) {
				t.Fatal("the rebuild differs from the recorded archive")
			}
			if res.Entries == 0 {
				t.Fatal("no entries")
			}
		})
	}
}

func TestRecordedArchiveWithAnotherNonce(t *testing.T) {
	m := fixture.Load(t)
	a := m.Archives[0]
	res, err := ustar.Validate(fixture.ArchiveBytes(t, a), a.MountPath, "ffffffffffffffff")
	wantCode(t, res, err, deny.TarNonce)
}

func TestRecordedArchiveOnAnotherMount(t *testing.T) {
	// The full /data/hermes archive carries the apply directory, which may
	// exist only under /data/hermes.
	m := fixture.Load(t)
	for _, a := range m.Archives {
		if a.MountPath != hermes || a.ID != "full" {
			continue
		}
		archive := fixture.ArchiveBytes(t, a)
		for _, mount := range []string{"/workspace", "/scratch"} {
			res, err := ustar.Validate(archive, mount, a.Nonce)
			wantCode(t, res, err, deny.TarPath)
		}
	}
}

// --- valid archives of our own -----------------------------------------------

func TestValidShapes(t *testing.T) {
	long := strings.Repeat("a", 30)
	deep := []ustar.Entry{dirE(next(nonce))}
	dirPath := next(nonce)
	for i := 0; i < 4; i++ {
		dirPath += "/" + strings.Repeat(string(rune('a'+i)), 30)
		deep = append(deep, dirE(dirPath))
	}
	deep = append(deep, fileE(dirPath+"/file.txt", "x"))
	_ = long

	mode644 := plainEntries(nonce)
	mode644[2].Mode = 0o644

	twoThousand := []ustar.Entry{dirE(next(nonce))}
	for i := 0; i < ustar.MaxEntries-1; i++ {
		twoThousand = append(twoThousand, fileE(next(nonce)+"/f"+strconv.Itoa(i), ""))
	}

	bigFile := []ustar.Entry{dirE(next(nonce)), fileE(next(nonce)+"/big", strings.Repeat("x", ustar.MaxFile))}

	cases := []struct {
		name    string
		mount   string
		entries []ustar.Entry
	}{
		{"hermes full", hermes, hermesEntries(nonce)},
		{"workspace", "/workspace", plainEntries(nonce)},
		{"scratch", "/scratch", plainEntries(nonce)},
		{"only the staging directory", "/scratch", []ustar.Entry{dirE(next(nonce))}},
		{"mode 0644 file", "/workspace", mode644},
		{"prefix split of a long path", "/workspace", deep},
		{"exactly the entry limit", "/workspace", twoThousand},
		{"file of exactly the size limit", "/workspace", bigFile},
		{"empty file", "/workspace", []ustar.Entry{dirE(next(nonce)), fileE(next(nonce)+"/empty", "")}},
		{"file of one block", "/workspace", []ustar.Entry{dirE(next(nonce)), fileE(next(nonce)+"/b", strings.Repeat("y", 512))}},
		{"non-ASCII name", "/workspace", []ustar.Entry{dirE(next(nonce)), fileE(next(nonce)+"/é中.txt", "u")}},
		{"empty remove list", hermes, func() []ustar.Entry {
			e := hermesEntries(nonce)
			e[6] = fileE(apply(nonce)+"/remove.list", "")
			return e
		}()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wantOK(t, build(t, tc.entries), tc.mount, nonce)
		})
	}
}

func TestBuildRefusesAPathThatDoesNotFit(t *testing.T) {
	p := next(nonce) + "/" + strings.Repeat("x", 300)
	if _, err := ustar.Build([]ustar.Entry{fileE(p, "")}); err == nil {
		t.Fatal("Build accepted a path over 255 bytes")
	}
	// One segment longer than the 100-byte name field does not fit either.
	p = next(nonce) + "/" + strings.Repeat("x", 101)
	if _, err := ustar.Build([]ustar.Entry{fileE(p, "")}); err == nil {
		t.Fatal("Build accepted a segment over 100 bytes")
	}
}

// --- denied archives, built with the writer of the tests -----------------------

// RT1_4: a path that leaves the staging tree, in any spelling.
func TestRedTeam_RT1_4_TarPaths(t *testing.T) {
	n := nonce
	base := func(extra ...ustar.Entry) []ustar.Entry {
		return append([]ustar.Entry{dirE(next(n))}, extra...)
	}
	cases := []struct {
		name    string
		entries []ustar.Entry
		code    string
	}{
		{"file outside the staging tree", base(fileE("evil", "x")), deny.TarPath},
		{"directory outside", []ustar.Entry{dirE("evil"), dirE(next(n))}, deny.TarPath},
		{"absolute path", base(fileE("/etc/cron.d/x", "x")), deny.TarPath},
		{"absolute path into the staging name", base(fileE("/"+next(n)+"/x", "x")), deny.TarPath},
		{"old directory", []ustar.Entry{dirE(next(n)), dirE(".myrmidon-old-" + n)}, deny.TarPath},
		{"root marker directory", []ustar.Entry{dirE(next(n)), dirE(".myrmidon")}, deny.TarPath},
		{"parent segment", base(fileE(next(n)+"/../x", "x")), deny.TarPath},
		{"parent segment deeper", base(dirE(next(n)+"/a"), fileE(next(n)+"/a/../../x", "x")), deny.TarPath},
		{"dot segment", base(fileE(next(n)+"/./x", "x")), deny.TarPath},
		{"empty segment", base(fileE(next(n)+"//x", "x")), deny.TarPath},
		{"trailing dot dot", base(dirE(next(n) + "/..")), deny.TarPath},
		{"backslash", base(fileE(next(n)+`/a\b`, "x")), deny.TarPath},
		{"control character", base(fileE(next(n)+"/a\x01b", "x")), deny.TarPath},
		{"newline in a name", base(fileE(next(n)+"/a\nb", "x")), deny.TarPath},
		{"DEL", base(fileE(next(n)+"/a\x7fb", "x")), deny.TarPath},
		{"reserved segment", base(fileE(next(n)+"/.myrmidon-x", "x")), deny.TarPath},
		{"reserved directory", base(dirE(next(n)+"/.myrmidon"), fileE(next(n)+"/.myrmidon/applied.json", "{}")), deny.TarPath},
		{"reserved segment in the middle", base(dirE(next(n)+"/a"), dirE(next(n)+"/a/.myrmidon-old"), fileE(next(n)+"/a/.myrmidon-old/x", "x")), deny.TarPath},
		{"invalid UTF-8", base(fileE(next(n)+"/\xff\xfe", "x")), deny.TarPath},
		{"another nonce, next", []ustar.Entry{dirE(next(n)), dirE(next("fedcba9876543210"))}, deny.TarNonce},
		{"another nonce, next, file", []ustar.Entry{dirE(next("fedcba9876543210")), dirE(next(n))}, deny.TarNonce},
		{"nonce prefix only", []ustar.Entry{dirE(next(n)), dirE(next(n[:15]))}, deny.TarNonce},
		{"nonce with a suffix", []ustar.Entry{dirE(next(n)), dirE(next(n) + "x")}, deny.TarNonce},
		{"another nonce, apply", []ustar.Entry{dirE(next(n)), dirE(apply("fedcba9876543210"))}, deny.TarNonce},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			arch, err := ustar.Build(tc.entries)
			if err != nil {
				t.Skipf("the writer cannot express it: %v", err)
			}
			res, verr := ustar.Validate(arch, hermes, n)
			wantCode(t, res, verr, tc.code)
		})
	}
}

func TestRedTeam_RT1_4_TarStructure(t *testing.T) {
	n := nonce
	d := dirE(next(n))
	cases := []struct {
		name    string
		mount   string
		entries []ustar.Entry
		code    string
	}{
		{"duplicate file", "/workspace", []ustar.Entry{d, fileE(next(n)+"/a", "1"), fileE(next(n)+"/a", "2")}, deny.TarOrder},
		{"duplicate directory", "/workspace", []ustar.Entry{d, d}, deny.TarOrder},
		{"directory after a file", "/workspace", []ustar.Entry{d, fileE(next(n)+"/a", "1"), dirE(next(n) + "/b")}, deny.TarOrder},
		{"parent missing", "/workspace", []ustar.Entry{d, fileE(next(n)+"/a/b", "1")}, deny.TarOrder},
		{"parent after child", "/workspace", []ustar.Entry{d, dirE(next(n) + "/a/b"), dirE(next(n) + "/a")}, deny.TarOrder},
		{"file where a directory is needed", "/workspace", []ustar.Entry{d, fileE(next(n)+"/a", "1"), fileE(next(n)+"/a/b", "2")}, deny.TarOrder},

		{"no staging directory", "/workspace", []ustar.Entry{}, deny.TarContent},
		{"the staging directory is a file", "/workspace", []ustar.Entry{fileE(next(n), "x")}, deny.TarContent},
		{"apply files without the staging directory", hermes, []ustar.Entry{dirE(apply(n)), fileE(apply(n)+"/applied.json", applied), fileE(apply(n)+"/remove.list", "")}, deny.TarContent},
		{"hermes without the apply directory", hermes, []ustar.Entry{d}, deny.TarContent},
		{"hermes without remove.list", hermes, []ustar.Entry{d, dirE(apply(n)), fileE(apply(n)+"/applied.json", applied)}, deny.TarContent},
		{"hermes without applied.json", hermes, []ustar.Entry{d, dirE(apply(n)), fileE(apply(n)+"/remove.list", "")}, deny.TarContent},

		{"apply directory outside hermes", "/workspace", []ustar.Entry{d, dirE(apply(n))}, deny.TarPath},
		{"apply file outside hermes", "/scratch", []ustar.Entry{d, dirE(apply(n)), fileE(apply(n)+"/applied.json", applied)}, deny.TarPath},
		{"another file in the apply directory", hermes, append(hermesEntries(n), fileE(apply(n)+"/extra", "x")), deny.TarPath},
		{"a subdirectory in the apply directory", hermes, []ustar.Entry{d, dirE(apply(n)), dirE(apply(n) + "/sub")}, deny.TarPath},
		{"the apply entry is a file", hermes, []ustar.Entry{d, fileE(apply(n), "x")}, deny.TarPath},
		{"applied.json is a directory", hermes, []ustar.Entry{d, dirE(apply(n)), dirE(apply(n) + "/applied.json")}, deny.TarPath},

		{"applied.json is not JSON", hermes, withApplied("not json"), deny.TarContent},
		{"applied.json is an array", hermes, withApplied(`[]`), deny.TarContent},
		{"applied.json has an extra key", hermes, withApplied(`{"restartHash":"r","filesHash":"f","files":[],"x":1}`), deny.TarContent},
		{"applied.json misses a key", hermes, withApplied(`{"restartHash":"r","files":[]}`), deny.TarContent},
		{"applied.json restartHash is a number", hermes, withApplied(`{"restartHash":1,"filesHash":"f","files":[]}`), deny.TarContent},
		{"applied.json files is not an array", hermes, withApplied(`{"restartHash":"r","filesHash":"f","files":"x"}`), deny.TarContent},
		{"applied.json files holds a number", hermes, withApplied(`{"restartHash":"r","filesHash":"f","files":[1]}`), deny.TarContent},
		{"applied.json with a duplicate key", hermes, withApplied(`{"restartHash":"r","restartHash":"r","filesHash":"f","files":[]}`), deny.TarContent},
		{"applied.json too large", hermes, withApplied(`{"restartHash":"` + strings.Repeat("a", ustar.MaxApplied) + `","filesHash":"f","files":[]}`), deny.TarContent},

		{"remove.list without a final newline", hermes, withRemove("hermes/a"), deny.TarContent},
		{"remove.list with an empty line", hermes, withRemove("hermes/a\n\n"), deny.TarContent},
		{"remove.list outside the three roots", hermes, withRemove("etc/passwd\n"), deny.TarContent},
		{"remove.list absolute", hermes, withRemove("/etc/passwd\n"), deny.TarContent},
		{"remove.list with a parent segment", hermes, withRemove("hermes/../x\n"), deny.TarContent},
		{"remove.list with a reserved segment", hermes, withRemove("hermes/.myrmidon/applied.json\n"), deny.TarContent},
		{"remove.list with a bare root", hermes, withRemove("hermes\n"), deny.TarContent},
		{"remove.list with an empty path", hermes, withRemove("hermes/\n"), deny.TarContent},
		{"remove.list with a backslash", hermes, withRemove("hermes/a\\b\n"), deny.TarContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			arch := build(t, tc.entries)
			res, err := ustar.Validate(arch, tc.mount, n)
			wantCode(t, res, err, tc.code)
		})
	}
}

func withApplied(content string) []ustar.Entry {
	e := hermesEntries(nonce)
	e[5] = fileE(apply(nonce)+"/applied.json", content)
	return e
}

func withRemove(content string) []ustar.Entry {
	e := hermesEntries(nonce)
	e[6] = fileE(apply(nonce)+"/remove.list", content)
	return e
}

func TestRedTeam_RT1_4_TarLimits(t *testing.T) {
	n := nonce
	t.Run("file over the size limit", func(t *testing.T) {
		arch := build(t, []ustar.Entry{dirE(next(n)), fileE(next(n)+"/big", strings.Repeat("x", ustar.MaxFile+1))})
		res, err := ustar.Validate(arch, "/workspace", n)
		wantCode(t, res, err, deny.TarTooLarge)
	})
	t.Run("one entry over the limit", func(t *testing.T) {
		e := []ustar.Entry{dirE(next(n))}
		for i := 0; i < ustar.MaxEntries; i++ {
			e = append(e, fileE(next(n)+"/f"+strconv.Itoa(i), ""))
		}
		res, err := ustar.Validate(build(t, e), "/workspace", n)
		wantCode(t, res, err, deny.TarTooLarge)
	})
	t.Run("archive over the size limit", func(t *testing.T) {
		res, err := ustar.Validate(make([]byte, ustar.MaxArchive+512), "/workspace", n)
		wantCode(t, res, err, deny.BodyTooLarge)
	})
}

// --- byte-level damage ---------------------------------------------------------

const blk = 512

func offsetOf(entries []ustar.Entry, i int) int {
	off := 0
	for j := 0; j < i; j++ {
		off += blk
		if r := len(entries[j].Data) % blk; r != 0 {
			off += len(entries[j].Data) + blk - r
		} else {
			off += len(entries[j].Data)
		}
	}
	return off
}

// fix recomputes the checksum of the header at off.
func fix(b []byte, off int) {
	h := b[off : off+blk]
	sum := 0
	for i, c := range h {
		if i >= 148 && i < 156 {
			c = ' '
		}
		sum += int(c)
	}
	s := strconv.FormatInt(int64(sum), 8)
	for len(s) < 6 {
		s = "0" + s
	}
	copy(h[148:154], s)
	h[154] = 0
	h[155] = ' '
}

func patch(b []byte, off, at int, v string) []byte {
	c := append([]byte(nil), b...)
	copy(c[off+at:], v)
	return c
}

func TestRedTeam_RT1_4_TarHeaderDamage(t *testing.T) {
	entries := plainEntries(nonce)
	const fileIdx = 2
	arch := build(t, entries)
	dirOff := offsetOf(entries, 0)
	fileOff := offsetOf(entries, fileIdx)

	type damage struct {
		name  string
		off   int
		at    int
		value string
		fixup bool
		code  string
	}
	cases := []damage{
		{"symlink", dirOff, 156, "2", true, deny.TarType},
		{"hard link", fileOff, 156, "1", true, deny.TarType},
		{"character device", fileOff, 156, "3", true, deny.TarType},
		{"block device", fileOff, 156, "4", true, deny.TarType},
		{"fifo", fileOff, 156, "6", true, deny.TarType},
		{"pax header", fileOff, 156, "x", true, deny.TarType},
		{"pax global header", fileOff, 156, "g", true, deny.TarType},
		{"GNU long name", fileOff, 156, "L", true, deny.TarType},
		{"GNU long link", fileOff, 156, "K", true, deny.TarType},
		{"contiguous file", fileOff, 156, "7", true, deny.TarType},
		{"old-style regular file", fileOff, 156, "\x00", true, deny.TarType},

		{"uid 0", fileOff, 108, "0000000\x00", true, deny.TarOwner},
		{"uid 1000", fileOff, 108, "0001750\x00", true, deny.TarOwner},
		{"gid 0", fileOff, 116, "0000000\x00", true, deny.TarOwner},
		{"gid 1000", dirOff, 116, "0001750\x00", true, deny.TarOwner},

		{"file mode 0755", fileOff, 100, "0000755\x00", true, deny.TarMode},
		{"file mode 0777", fileOff, 100, "0000777\x00", true, deny.TarMode},
		{"file mode setuid", fileOff, 100, "0004755\x00", true, deny.TarMode},
		{"file mode 0666", fileOff, 100, "0000666\x00", true, deny.TarMode},
		{"file mode 0000", fileOff, 100, "0000000\x00", true, deny.TarMode},
		{"dir mode 0755", dirOff, 100, "0000755\x00", true, deny.TarMode},
		{"dir mode 0777", dirOff, 100, "0000777\x00", true, deny.TarMode},
		{"dir mode 0600", dirOff, 100, "0000600\x00", true, deny.TarMode},
		{"dir mode sticky", dirOff, 100, "0001700\x00", true, deny.TarMode},

		{"bad magic", fileOff, 257, "ustar ", true, deny.TarSyntax},
		{"bad version", fileOff, 263, " \x00", true, deny.TarSyntax},
		{"no magic", fileOff, 257, "\x00\x00\x00\x00\x00\x00", true, deny.TarSyntax},
		{"checksum not fixed", fileOff, 100, "0000640\x00", false, deny.TarSyntax},
		{"checksum field ends with NUL", fileOff, 155, "\x00", false, deny.TarSyntax},
		{"checksum field with a letter", fileOff, 148, "00000x", false, deny.TarSyntax},
		{"size in base 256", fileOff, 124, "\x80", true, deny.TarSyntax},
		{"size with a non-octal digit", fileOff, 124, "0000000008\x00", true, deny.TarSyntax},
		{"size without the NUL", fileOff, 135, "1", true, deny.TarSyntax},
		{"mtime in base 256", fileOff, 136, "\x80", true, deny.TarSyntax},
		{"mtime with a space", fileOff, 136, " 000000001", true, deny.TarSyntax},
		{"uid in base 256", fileOff, 108, "\x80", true, deny.TarSyntax},
		{"mode without the NUL", fileOff, 107, "0", true, deny.TarSyntax},
		{"link name", fileOff, 157, "target", true, deny.TarSyntax},
		{"dev major", fileOff, 329, "0000001\x00", true, deny.TarSyntax},
		{"dev minor", fileOff, 337, "0000001\x00", true, deny.TarSyntax},
		{"user name", fileOff, 265, "root", true, deny.TarSyntax},
		{"group name", fileOff, 297, "root", true, deny.TarSyntax},
		{"directory without the slash", dirOff, 12 + 3, "\x00", true, deny.TarPath},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bad := patch(arch, tc.off, tc.at, tc.value)
			if tc.fixup {
				fix(bad, tc.off)
			}
			res, err := ustar.Validate(bad, "/workspace", nonce)
			if tc.name == "directory without the slash" {
				// Name ".myrmidon-next-<16>" is 31 bytes; cut it at byte 15 so the
				// slash of the directory is lost together with the rest of the name.
				_ = res
			}
			if err == nil {
				t.Fatalf("accepted")
			}
			if err.Code != tc.code && !(tc.name == "directory without the slash" && (err.Code == deny.TarPath || err.Code == deny.TarNonce)) {
				t.Fatalf("denied as %s (%s), want %s", err.Code, err.Detail, tc.code)
			}
		})
	}
}

func TestRedTeam_RT1_4_TarFraming(t *testing.T) {
	entries := plainEntries(nonce)
	arch := build(t, entries)
	zero := make([]byte, blk)
	cases := []struct {
		name string
		data []byte
		code string
	}{
		{"empty", nil, deny.TarSyntax},
		{"one block", make([]byte, blk), deny.TarSyntax},
		{"not a multiple of the block", append(append([]byte(nil), arch...), 'x'), deny.TarSyntax},
		{"no end blocks", arch[:len(arch)-2*blk], deny.TarSyntax},
		{"one end block", arch[:len(arch)-blk], deny.TarSyntax},
		{"three end blocks", append(append([]byte(nil), arch...), zero...), deny.TarSyntax},
		{"data after the end blocks", append(append([]byte(nil), arch...), append([]byte("junk"), make([]byte, blk-4)...)...), deny.TarSyntax},
		{"end blocks in the middle", append(append(append([]byte(nil), arch[:blk]...), make([]byte, 2*blk)...), arch[blk:]...), deny.TarSyntax},
		{"only the end blocks", make([]byte, 2*blk), deny.TarContent},
		{"file data cut short", cutData(t), deny.TarSyntax},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := ustar.Validate(tc.data, "/workspace", nonce)
			wantCode(t, res, err, tc.code)
		})
	}
}

// cutData is an archive whose last file header promises more data than the
// archive holds.
func cutData(t *testing.T) []byte {
	t.Helper()
	e := []ustar.Entry{dirE(next(nonce)), fileE(next(nonce)+"/f", strings.Repeat("z", 2048))}
	full := build(t, e)
	// Header of the file, one block of its data, and the end blocks.
	off := offsetOf(e, 1)
	return append(append([]byte(nil), full[:off+blk+blk]...), make([]byte, 2*blk)...)
}

// Bytes that the parser reads but that the rebuild writes differently: they
// must make the rebuild differ, so the archive is refused.
func TestRedTeam_RT1_4_TarNotCanonical(t *testing.T) {
	entries := plainEntries(nonce)
	arch := build(t, entries)
	fileOff := offsetOf(entries, 2)
	cases := []struct {
		name string
		mut  func([]byte)
	}{
		{"junk in the data padding", func(b []byte) { b[fileOff+blk+5] = 'J' }},
		{"junk in the header padding", func(b []byte) { b[fileOff+500] = 'J'; fix(b, fileOff) }},
		{"junk after the name", func(b []byte) { b[fileOff+90] = 'J'; fix(b, fileOff) }},
		{"junk in the prefix field of a short path", func(b []byte) { b[fileOff+345+100] = 'J'; fix(b, fileOff) }},
		{"junk after the user name", func(b []byte) { b[fileOff+265+20] = 'J'; fix(b, fileOff) }},
		{"another checksum spelling", func(b []byte) {
			// The same value, but a space and a NUL swapped: no longer "NUL, space".
			b[fileOff+154], b[fileOff+155] = ' ', 0
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bad := append([]byte(nil), arch...)
			tc.mut(bad)
			res, err := ustar.Validate(bad, "/workspace", nonce)
			if err == nil {
				t.Fatalf("accepted %d entries", res.Entries)
			}
			switch err.Code {
			case deny.TarNotCanonical, deny.TarSyntax, deny.TarPath:
			default:
				t.Fatalf("denied as %s (%s)", err.Code, err.Detail)
			}
		})
	}
}

func TestPaddingJunkIsNotCanonical(t *testing.T) {
	entries := plainEntries(nonce)
	arch := build(t, entries)
	// The data of the file is one byte; its padding is 511 bytes of zeros.
	bad := append([]byte(nil), arch...)
	bad[offsetOf(entries, 2)+blk+1] = 'J'
	res, err := ustar.Validate(bad, "/workspace", nonce)
	wantCode(t, res, err, deny.TarNotCanonical)
}

func TestOwnerConstant(t *testing.T) {
	if ustar.Owner != 10001 {
		t.Fatalf("owner %d", ustar.Owner)
	}
}
