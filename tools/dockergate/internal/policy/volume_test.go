package policy_test

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
)

const (
	vRoot = "/srv/bots"
	vKey  = "0a1b2c3d-1111-2222-3333-444455556666"
	vK    = vRoot + "/" + vKey
)

// tree is a fake file system for CheckVolumeRoot: a missing path is
// fs.ErrNotExist, an entry with err set returns it.
type tree map[string]entry

type entry struct {
	fi  policy.FileInfo
	err error
}

func (tr tree) lstat(p string) (policy.FileInfo, error) {
	e, ok := tr[p]
	if !ok {
		return policy.FileInfo{}, fs.ErrNotExist
	}
	return e.fi, e.err
}

func dir(uid, perm uint32) entry {
	return entry{fi: policy.FileInfo{Dir: true, UID: uid, Perm: perm}}
}

func base() tree {
	return tree{
		vRoot:             dir(0, 0o755),
		vK:                dir(0, 0o710),
		vK + "/hermes":    dir(policy.BotUID, 0o700),
		vK + "/workspace": dir(policy.BotUID, 0o700),
		vK + "/scratch":   dir(0, 0o755),
	}
}

func TestVolumeRootAccepts(t *testing.T) {
	cases := map[string]func(tree){
		"complete tree": func(tree) {},
		"no K yet": func(tr tree) {
			delete(tr, vK)
			delete(tr, vK+"/hermes")
			delete(tr, vK+"/workspace")
			delete(tr, vK+"/scratch")
		},
		"no children yet":        func(tr tree) { delete(tr, vK+"/hermes"); delete(tr, vK+"/workspace"); delete(tr, vK+"/scratch") },
		"one child":              func(tr tree) { delete(tr, vK+"/workspace"); delete(tr, vK+"/scratch") },
		"root owned children":    func(tr tree) { tr[vK+"/hermes"] = dir(0, 0o755) },
		"owner-only permissions": func(tr tree) { tr[vRoot] = dir(0, 0o700) },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			tr := base()
			mut(tr)
			if err := policy.CheckVolumeRoot(tr.lstat, vRoot, vKey); err != nil {
				t.Fatalf("denied: %s (%s)", err.Code, err.Detail)
			}
		})
	}
}

// RT1_1: a bind mount source that a bot could have swapped must be refused
// before a root helper is created on it.
func TestRedTeam_RT1_1_VolumeRoot(t *testing.T) {
	link := entry{fi: policy.FileInfo{Symlink: true, UID: 0, Perm: 0o777}}
	file := entry{fi: policy.FileInfo{UID: 0, Perm: 0o644}}
	linkToDir := entry{fi: policy.FileInfo{Dir: true, Symlink: true, UID: 0, Perm: 0o755}}
	eacces := entry{err: syscall.EACCES}
	eio := entry{err: errors.New("i/o error")}
	cases := []struct {
		name   string
		mut    func(tree)
		detail string
	}{
		{"root missing", func(tr tree) { delete(tr, vRoot) }, "volume.root"},
		{"root is a link", func(tr tree) { tr[vRoot] = link }, "volume.root"},
		{"root is a link to a dir", func(tr tree) { tr[vRoot] = linkToDir }, "volume.root"},
		{"root is a file", func(tr tree) { tr[vRoot] = file }, "volume.root"},
		{"root owned by a bot", func(tr tree) { tr[vRoot] = dir(policy.BotUID, 0o755) }, "volume.root"},
		{"root owned by uid 1000", func(tr tree) { tr[vRoot] = dir(1000, 0o755) }, "volume.root"},
		{"root group writable", func(tr tree) { tr[vRoot] = dir(0, 0o775) }, "volume.root"},
		{"root world writable", func(tr tree) { tr[vRoot] = dir(0, 0o757) }, "volume.root"},
		{"root unreadable", func(tr tree) { tr[vRoot] = eacces }, "volume.root"},
		{"K is a link", func(tr tree) { tr[vK] = link }, "volume.K"},
		{"K is a link to a dir", func(tr tree) { tr[vK] = linkToDir }, "volume.K"},
		{"K is a file", func(tr tree) { tr[vK] = file }, "volume.K"},
		{"K owned by the bot", func(tr tree) { tr[vK] = dir(policy.BotUID, 0o710) }, "volume.K"},
		{"K group writable", func(tr tree) { tr[vK] = dir(0, 0o770) }, "volume.K"},
		{"K world writable", func(tr tree) { tr[vK] = dir(0, 0o707) }, "volume.K"},
		{"K cannot be checked", func(tr tree) { tr[vK] = eacces }, "volume.K"},
		{"K lstat fails", func(tr tree) { tr[vK] = eio }, "volume.K"},
		{"hermes is a link", func(tr tree) { tr[vK+"/hermes"] = link }, "volume.hermes"},
		{"hermes is a link to a dir", func(tr tree) { tr[vK+"/hermes"] = linkToDir }, "volume.hermes"},
		{"hermes is a file", func(tr tree) { tr[vK+"/hermes"] = file }, "volume.hermes"},
		{"hermes owned by 1000", func(tr tree) { tr[vK+"/hermes"] = dir(1000, 0o700) }, "volume.hermes"},
		{"hermes owned by 65532", func(tr tree) { tr[vK+"/hermes"] = dir(65532, 0o700) }, "volume.hermes"},
		{"hermes group writable", func(tr tree) { tr[vK+"/hermes"] = dir(policy.BotUID, 0o770) }, "volume.hermes"},
		{"hermes world writable", func(tr tree) { tr[vK+"/hermes"] = dir(policy.BotUID, 0o777) }, "volume.hermes"},
		{"hermes cannot be checked", func(tr tree) { tr[vK+"/hermes"] = eacces }, "volume.hermes"},
		{"workspace is a link", func(tr tree) { tr[vK+"/workspace"] = link }, "volume.workspace"},
		{"workspace is a file", func(tr tree) { tr[vK+"/workspace"] = file }, "volume.workspace"},
		{"workspace owned by 1000", func(tr tree) { tr[vK+"/workspace"] = dir(1000, 0o700) }, "volume.workspace"},
		{"scratch is a link", func(tr tree) { tr[vK+"/scratch"] = link }, "volume.scratch"},
		{"scratch world writable", func(tr tree) { tr[vK+"/scratch"] = dir(0, 0o777) }, "volume.scratch"},
		{"scratch cannot be checked", func(tr tree) { tr[vK+"/scratch"] = eio }, "volume.scratch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tr := base()
			tc.mut(tr)
			err := policy.CheckVolumeRoot(tr.lstat, vRoot, vKey)
			if err == nil {
				t.Fatal("accepted")
			}
			if err.Code != deny.VolumeRootInvariant || err.Detail != tc.detail {
				t.Fatalf("denied as %s (%s), want %s (%s)", err.Code, err.Detail, deny.VolumeRootInvariant, tc.detail)
			}
		})
	}
}

// A different bot's tree is not looked at: the check follows the key.
func TestVolumeRootChecksOnlyItsOwnKey(t *testing.T) {
	tr := base()
	tr[vRoot+"/9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff"] = entry{fi: policy.FileInfo{Symlink: true}}
	if err := policy.CheckVolumeRoot(tr.lstat, vRoot, vKey); err != nil {
		t.Fatalf("denied: %s", err.Code)
	}
}

func TestOSLstat(t *testing.T) {
	d := t.TempDir()
	sub := filepath.Join(d, "sub")
	if err := os.Mkdir(sub, 0o750); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(d, "link")
	if err := os.Symlink(sub, link); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	file := filepath.Join(d, "file")
	if err := os.WriteFile(file, []byte("x"), 0o640); err != nil {
		t.Fatal(err)
	}

	fi, err := policy.OSLstat(sub)
	if err != nil || !fi.Dir || fi.Symlink || fi.UID != uint32(os.Getuid()) || fi.Perm != 0o750 {
		t.Fatalf("dir: %+v, %v", fi, err)
	}
	fi, err = policy.OSLstat(link)
	if err != nil || !fi.Symlink || fi.Dir {
		t.Fatalf("link must be reported as a link, not followed: %+v, %v", fi, err)
	}
	fi, err = policy.OSLstat(file)
	if err != nil || fi.Dir || fi.Symlink || fi.Perm != 0o640 {
		t.Fatalf("file: %+v, %v", fi, err)
	}
	if _, err = policy.OSLstat(filepath.Join(d, "none")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
}
