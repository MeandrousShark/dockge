// dockge-quadlet-helper is the intentionally narrow root-owned Quadlet reader.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"strconv"
	"syscall"

	"github.com/louislam/dockge/quadlet-helper/internal/config"
	"github.com/louislam/dockge/quadlet-helper/internal/quadlet"
	"github.com/louislam/dockge/quadlet-helper/internal/server"
)

// CI sets both values with -ldflags '-X main.helperVersion=... -X main.buildID=...'.
var helperVersion = "0.1.0-dev"
var buildID = "development"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "self-test" {
		selfTest(os.Args[2:])
		return
	}
	serve(os.Args[1:])
}
func common(args []string) (string, string) {
	fs := flag.NewFlagSet("dockge-quadlet-helper", flag.ExitOnError)
	conf := fs.String("config", "/etc/dockge/quadlet-helper.json", "")
	sock := fs.String("socket", "", "explicit test socket path")
	fs.Parse(args)
	return *conf, *sock
}
func selfTest(args []string) {
	conf, _ := common(args)
	c, err := config.Load(conf)
	if err != nil {
		fmt.Fprintln(os.Stderr, "self-test:", err)
		os.Exit(1)
	}
	binary, err := os.Executable()
	if err == nil {
		err = c.ValidateExecutables(binary)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "self-test:", err)
		os.Exit(1)
	}
	fmt.Println("self-test: ok")
}
func serve(args []string) {
	conf, sock := common(args)
	c, err := config.Load(conf)
	if err != nil {
		fmt.Fprintln(os.Stderr, "configuration:", err)
		os.Exit(1)
	}
	binary, err := os.Executable()
	if err == nil {
		err = c.ValidateExecutables(binary)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "configuration:", err)
		os.Exit(1)
	}
	l, err := listener(sock)
	if err != nil {
		fmt.Fprintln(os.Stderr, "listener:", err)
		os.Exit(1)
	}
	defer l.Close()
	s := server.New(c, l, quadlet.Service{C: c}, helperVersion, buildID, os.Stderr)
	if err = s.Serve(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "serve:", err)
		os.Exit(1)
	}
}
func listener(path string) (net.Listener, error) {
	if path != "" {
		return net.Listen("unix", path)
	}
	pid, _ := strconv.Atoi(os.Getenv("LISTEN_PID"))
	fds, _ := strconv.Atoi(os.Getenv("LISTEN_FDS"))
	if pid != os.Getpid() || fds != 1 {
		return nil, errors.New("expected exactly one systemd activation socket")
	}
	f := os.NewFile(uintptr(3), "systemd-listen-fd")
	l, err := net.FileListener(f)
	if err != nil {
		return nil, err
	}
	if _, ok := l.(*net.UnixListener); !ok {
		return nil, errors.New("activation fd is not a unix listener")
	}
	return l, nil
}

var _ = syscall.SOCK_STREAM
