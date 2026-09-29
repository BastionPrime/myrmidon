package peer

import (
	"errors"
	"net"
	"syscall"
)

// Cred is the peer of a unix socket connection, as the kernel recorded it at
// connect().
type Cred struct {
	PID int
	UID uint32
	GID uint32
}

// CredFunc reads the credentials of a connection. Tests replace it.
type CredFunc func(net.Conn) (Cred, error)

// SoCred reads SO_PEERCRED. The pid is the pid of the process in the namespace
// of dockergate (which runs in the host pid namespace).
func SoCred(c net.Conn) (Cred, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return Cred{}, errors.New("peercred: not a unix connection")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return Cred{}, err
	}
	var (
		ucred *syscall.Ucred
		gerr  error
	)
	if err := raw.Control(func(fd uintptr) {
		ucred, gerr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return Cred{}, err
	}
	if gerr != nil {
		return Cred{}, gerr
	}
	return Cred{PID: int(ucred.Pid), UID: ucred.Uid, GID: ucred.Gid}, nil
}
