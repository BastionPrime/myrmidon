package peer_test

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/peer"
)

func TestParseStat(t *testing.T) {
	const tail = "S 100 1 1 0 -1 4194560 100 0 0 0 5 6 0 0 20 0 1 0 12345 1000000 100"
	cases := []struct {
		name string
		line string
		want peer.Stat
		fail bool
	}{
		{"plain", "101 (node) " + tail, peer.Stat{Comm: "node", PPid: 100, StartTime: 12345}, false},
		{"a space in the name", "101 (my node) " + tail, peer.Stat{Comm: "my node", PPid: 100, StartTime: 12345}, false},
		{"parentheses in the name", "101 (no)de) x (y) " + tail, peer.Stat{Comm: "no)de) x (y", PPid: 100, StartTime: 12345}, false},
		{"a name that looks like fields", "101 (S 1 2 3) " + tail, peer.Stat{Comm: "S 1 2 3", PPid: 100, StartTime: 12345}, false},
		{"an empty name", "101 () " + tail, peer.Stat{Comm: "", PPid: 100, StartTime: 12345}, false},
		{"no name", "101 node " + tail, peer.Stat{}, true},
		{"only a closing parenthesis", "101 node) " + tail, peer.Stat{}, true},
		{"too short", "101 (a) S 1 2", peer.Stat{}, true},
		{"ppid not a number", "101 (a) S x 1 1 0 -1 4194560 100 0 0 0 5 6 0 0 20 0 1 0 12345 1", peer.Stat{}, true},
		{"starttime not a number", "101 (a) S 100 1 1 0 -1 4194560 100 0 0 0 5 6 0 0 20 0 1 0 x 1", peer.Stat{}, true},
		{"empty", "", peer.Stat{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := peer.ParseStat([]byte(tc.line))
			if tc.fail {
				if err == nil {
					t.Fatalf("accepted: %+v", got)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %+v (%v), want %+v", got, err, tc.want)
			}
		})
	}
}

func TestParseStatus(t *testing.T) {
	good := "Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nUid:\t1000\t1001\t1002\t1003\nGid:\t2000\t2001\t2002\t2003\nGroups:\t1000\n"
	st, err := peer.ParseStatus([]byte(good))
	if err != nil {
		t.Fatal(err)
	}
	if st.UIDs != [4]uint32{1000, 1001, 1002, 1003} || st.GIDs != [4]uint32{2000, 2001, 2002, 2003} {
		t.Fatalf("%+v", st)
	}
	for name, bad := range map[string]string{
		"empty":         "",
		"no gid":        "Uid:\t1\t1\t1\t1\n",
		"no uid":        "Gid:\t1\t1\t1\t1\n",
		"three uids":    "Uid:\t1\t1\t1\nGid:\t1\t1\t1\t1\n",
		"five gids":     "Uid:\t1\t1\t1\t1\nGid:\t1\t1\t1\t1\t1\n",
		"not a number":  "Uid:\t1\tx\t1\t1\nGid:\t1\t1\t1\t1\n",
		"negative":      "Uid:\t-1\t1\t1\t1\nGid:\t1\t1\t1\t1\n",
		"out of range":  "Uid:\t99999999999\t1\t1\t1\nGid:\t1\t1\t1\t1\n",
		"only the name": "Name:\tnode\n",
	} {
		if st, err := peer.ParseStatus([]byte(bad)); err == nil {
			t.Errorf("%s: accepted %+v", name, st)
		}
	}
}

func TestParseCmdline(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"node\x00server.js\x00", []string{"node", "server.js"}},
		{"node\x00server.js", []string{"node", "server.js"}},
		{"a\x00\x00b\x00", []string{"a", "", "b"}},
		{"", nil},
		{"x", []string{"x"}},
		{"\x00", []string{""}},
	}
	for _, tc := range cases {
		if got := peer.ParseCmdline([]byte(tc.in)); !slices.Equal(got, tc.want) {
			t.Errorf("%q: got %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestParseCgroupLeaf(t *testing.T) {
	cases := []struct {
		in   string
		want string
		fail bool
	}{
		{"0::/system.slice/docker-abc.scope\n", "docker-abc.scope", false},
		{"12:cpu:/x\n0::/a/b\n", "b", false},
		{"0::/docker-abc.scope", "docker-abc.scope", false},
		{"0::/\n", "", false},
		{"1:name=systemd:/x\n2:cpu:/y\n", "", true},
		{"", "", true},
	}
	for _, tc := range cases {
		got, err := peer.ParseCgroupLeaf([]byte(tc.in))
		if tc.fail {
			if err == nil {
				t.Errorf("%q: accepted %q", tc.in, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%q: got %q (%v), want %q", tc.in, got, err, tc.want)
		}
	}
}

func writeProc(t *testing.T, root string, pid string, files map[string]string) {
	t.Helper()
	dir := filepath.Join(root, pid)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOSProcReadsATree(t *testing.T) {
	root := t.TempDir()
	writeProc(t, root, "101", map[string]string{
		"stat":    "101 (node) S 100 1 1 0 -1 4194560 100 0 0 0 5 6 0 0 20 0 1 0 12345 1000000 100\n",
		"status":  "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n",
		"cmdline": "node\x00server.js\x00",
		"cgroup":  "0::/system.slice/docker-abc.scope\n",
	})
	writeProc(t, root, "102", map[string]string{})
	writeProc(t, root, "self", map[string]string{})
	writeProc(t, root, "sys", map[string]string{})
	writeProc(t, root, "0", map[string]string{})
	if err := os.WriteFile(filepath.Join(root, "7"), []byte("a file, not a process"), 0o644); err != nil {
		t.Fatal(err)
	}

	p := peer.OSProc{Root: root}
	pids, err := p.Pids()
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(pids)
	if !slices.Equal(pids, []int{7, 101, 102}) {
		// a regular file with a numeric name is listed too: its stat cannot be read.
		t.Fatalf("pids %v", pids)
	}
	st, err := p.Stat(101)
	if err != nil || st != (peer.Stat{Comm: "node", PPid: 100, StartTime: 12345}) {
		t.Fatalf("%+v %v", st, err)
	}
	ss, err := p.Status(101)
	if err != nil || ss.UIDs != [4]uint32{1000, 1000, 1000, 1000} {
		t.Fatalf("%+v %v", ss, err)
	}
	argv, err := p.Cmdline(101)
	if err != nil || !slices.Equal(argv, []string{"node", "server.js"}) {
		t.Fatalf("%q %v", argv, err)
	}
	leaf, err := p.CgroupLeaf(101)
	if err != nil || leaf != "docker-abc.scope" {
		t.Fatalf("%q %v", leaf, err)
	}
	if _, err := p.Stat(102); err == nil {
		t.Fatal("a process without a stat file was read")
	}
	if _, err := p.Stat(999); err == nil {
		t.Fatal("a missing process was read")
	}
	if _, err := (peer.OSProc{Root: filepath.Join(root, "missing")}).Pids(); err == nil {
		t.Fatal("a missing root was listed")
	}
}

func TestOSProcReadsTheRealProc(t *testing.T) {
	if _, err := os.Stat("/proc/self/stat"); err != nil {
		t.Skip("no /proc")
	}
	p := peer.OSProc{}
	st, err := p.Stat(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if st.StartTime == 0 || st.PPid != os.Getppid() {
		t.Fatalf("%+v", st)
	}
	ss, err := p.Status(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if ss.UIDs[0] != uint32(os.Getuid()) {
		t.Fatalf("%+v", ss)
	}
	argv, err := p.Cmdline(os.Getpid())
	if err != nil || len(argv) == 0 {
		t.Fatalf("%q %v", argv, err)
	}
	pids, err := p.Pids()
	if err != nil || !slices.Contains(pids, os.Getpid()) {
		t.Fatalf("pids: %v", err)
	}
}
