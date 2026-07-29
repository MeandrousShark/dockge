//go:build linux

package peer

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestCredentialsReportsLinuxPeer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peer.sock")
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	accepted := make(chan *net.UnixConn, 1)
	go func() {
		c, e := l.AcceptUnix()
		if e == nil {
			accepted <- c
		}
	}()
	c, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	s := <-accepted
	defer s.Close()
	uid, pid, err := Credentials(s)
	if err != nil {
		t.Fatal(err)
	}
	if uid != os.Getuid() || pid < 1 {
		t.Fatalf("uid=%d pid=%d", uid, pid)
	}
}
