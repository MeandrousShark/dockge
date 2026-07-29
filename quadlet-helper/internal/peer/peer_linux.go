//go:build linux

package peer

import (
	"net"
	"syscall"
)

// Credentials obtains SO_PEERCRED before any untrusted bytes are read.
func Credentials(conn *net.UnixConn) (uid, pid int, err error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	err = raw.Control(func(fd uintptr) {
		cred, e := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		if e != nil {
			err = e
			return
		}
		uid, pid = int(cred.Uid), int(cred.Pid)
	})
	return uid, pid, err
}
