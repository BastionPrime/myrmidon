// Package peer decides who is calling: it reads the credentials of the unix
// socket peer (SO_PEERCRED), pins the main process of the board container by a
// walk over /proc, and defends the listener against a flood of foreign
// callers. Every fact about a process comes from a ProcReader, so that tests
// run against a fake /proc tree.
package peer

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Stat is the part of /proc/<pid>/stat that dockergate reads.
type Stat struct {
	Comm      string
	PPid      int
	StartTime uint64
}

// Status is the four uids and four gids of /proc/<pid>/status (real,
// effective, saved, file system).
type Status struct {
	UIDs [4]uint32
	GIDs [4]uint32
}

// ProcReader is the view of /proc that the resolver and the authenticator use.
type ProcReader interface {
	// Pids lists the processes.
	Pids() ([]int, error)
	Stat(pid int) (Stat, error)
	Status(pid int) (Status, error)
	// Cmdline is the argv of the process, split at NUL.
	Cmdline(pid int) ([]string, error)
	// CgroupLeaf is the last path component of the cgroup v2 line ("0::").
	CgroupLeaf(pid int) (string, error)
}

// ParseStat parses the content of /proc/<pid>/stat. The command name is
// enclosed in parentheses and may itself contain spaces and parentheses, so
// the fields are read after the last ")": ppid is field 4, starttime field 22.
func ParseStat(data []byte) (Stat, error) {
	open := bytes.IndexByte(data, '(')
	closing := bytes.LastIndexByte(data, ')')
	if open < 0 || closing < open {
		return Stat{}, errors.New("stat: no comm")
	}
	fields := strings.Fields(string(data[closing+1:]))
	// fields[0] is field 3 (state), so field N is fields[N-3].
	if len(fields) < 20 {
		return Stat{}, errors.New("stat: short")
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return Stat{}, errors.New("stat: ppid")
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return Stat{}, errors.New("stat: starttime")
	}
	return Stat{Comm: string(data[open+1 : closing]), PPid: ppid, StartTime: start}, nil
}

// ParseStatus parses the Uid and Gid lines of /proc/<pid>/status.
func ParseStatus(data []byte) (Status, error) {
	var st Status
	var gotU, gotG bool
	for _, line := range strings.Split(string(data), "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok || (key != "Uid" && key != "Gid") {
			continue
		}
		f := strings.Fields(val)
		if len(f) != 4 {
			return Status{}, errors.New("status: " + key)
		}
		for i, s := range f {
			n, err := strconv.ParseUint(s, 10, 32)
			if err != nil {
				return Status{}, errors.New("status: " + key)
			}
			if key == "Uid" {
				st.UIDs[i] = uint32(n)
			} else {
				st.GIDs[i] = uint32(n)
			}
		}
		if key == "Uid" {
			gotU = true
		} else {
			gotG = true
		}
	}
	if !gotU || !gotG {
		return Status{}, errors.New("status: incomplete")
	}
	return st, nil
}

// ParseCmdline splits /proc/<pid>/cmdline at NUL. The file ends with a NUL,
// which does not start another argument.
func ParseCmdline(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	data = bytes.TrimSuffix(data, []byte{0})
	return strings.Split(string(data), "\x00")
}

// ParseCgroupLeaf returns the last path component of the "0::" line.
func ParseCgroupLeaf(data []byte) (string, error) {
	for _, line := range strings.Split(string(data), "\n") {
		if p, ok := strings.CutPrefix(line, "0::"); ok {
			return p[strings.LastIndexByte(p, '/')+1:], nil
		}
	}
	return "", errors.New("cgroup: no v2 line")
}

// OSProc reads the real /proc.
type OSProc struct {
	// Root is the mount of proc, "/proc" when empty.
	Root string
}

func (o OSProc) root() string {
	if o.Root == "" {
		return "/proc"
	}
	return o.Root
}

func (o OSProc) read(pid int, name string) ([]byte, error) {
	return os.ReadFile(fmt.Sprintf("%s/%d/%s", o.root(), pid, name))
}

// Pids lists the numeric directories of /proc.
func (o OSProc) Pids() ([]int, error) {
	entries, err := os.ReadDir(o.root())
	if err != nil {
		return nil, err
	}
	var pids []int
	for _, e := range entries {
		if n, err := strconv.Atoi(e.Name()); err == nil && n > 0 {
			pids = append(pids, n)
		}
	}
	return pids, nil
}

func (o OSProc) Stat(pid int) (Stat, error) {
	b, err := o.read(pid, "stat")
	if err != nil {
		return Stat{}, err
	}
	return ParseStat(b)
}

func (o OSProc) Status(pid int) (Status, error) {
	b, err := o.read(pid, "status")
	if err != nil {
		return Status{}, err
	}
	return ParseStatus(b)
}

func (o OSProc) Cmdline(pid int) ([]string, error) {
	b, err := o.read(pid, "cmdline")
	if err != nil {
		return nil, err
	}
	return ParseCmdline(b), nil
}

func (o OSProc) CgroupLeaf(pid int) (string, error) {
	b, err := o.read(pid, "cgroup")
	if err != nil {
		return "", err
	}
	return ParseCgroupLeaf(b)
}
