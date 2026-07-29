package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/louislam/dockge/quadlet-helper/internal/config"
	"github.com/louislam/dockge/quadlet-helper/internal/protocol"
	"github.com/louislam/dockge/quadlet-helper/internal/quadlet"
)

type idleRunner struct{ reader *io.PipeReader }

func (r idleRunner) Run(context.Context, string, ...string) ([]byte, error) { return nil, nil }
func (r idleRunner) Start(context.Context, string, ...string) (io.ReadCloser, func() error, error) {
	return r.reader, func() error { return nil }, nil
}

type syncAudit struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (a *syncAudit) Write(p []byte) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.b.Write(p)
}
func (a *syncAudit) Snapshot() []byte {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]byte(nil), a.b.Bytes()...)
}

func testServer(t *testing.T, uid int) (*Server, string, *syncAudit, context.CancelFunc) {
	t.Helper()
	c := config.Defaults()
	c.AllowedPeerUID = uid
	base := t.TempDir()
	c.Roots = map[string]string{"admin": filepath.Join(base, "a"), "runtime": filepath.Join(base, "r"), "distribution": filepath.Join(base, "d")}
	for _, p := range c.Roots {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(base, "helper.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	audit := &syncAudit{}
	s := New(c, l, quadlet.Service{C: c, MapUnits: func(context.Context, map[string]string) (map[string]string, error) { return map[string]string{}, nil }}, "test", "test", audit)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = s.Serve(ctx) }()
	return s, path, audit, func() { cancel(); _ = l.Close() }
}
func TestCapabilitiesAndUnsupportedOperation(t *testing.T) {
	_, path, audit, stop := testServer(t, os.Getuid())
	defer stop()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	req := `{"version":1,"id":"id1","operation":"helper.capabilities","arguments":{}}`
	if err := protocol.WriteFrame(conn, json.RawMessage(req), 65536); err != nil {
		t.Fatal(err)
	}
	b, err := protocol.ReadFrame(conn, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"helperVersion":"test"`)) {
		t.Fatalf("capability response %s", b)
	}
	conn2, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.Close()
	req = `{"version":1,"id":"id2","operation":"run","arguments":{}}`
	if err := protocol.WriteFrame(conn2, json.RawMessage(req), 65536); err != nil {
		t.Fatal(err)
	}
	b, err = protocol.ReadFrame(conn2, 1<<20)
	if err != nil || !bytes.Contains(b, []byte(`"unsupported_operation"`)) {
		t.Fatalf("unsupported response %s: %v", b, err)
	}
	deadline := time.Now().Add(time.Second)
	for !bytes.Contains(audit.Snapshot(), []byte(`"result":"unsupported_operation"`)) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !bytes.Contains(audit.Snapshot(), []byte(`"result":"unsupported_operation"`)) {
		t.Fatalf("audit missing stable error: %s", audit.Snapshot())
	}
}
func TestUnauthorizedPeerReadIsClosedBeforeParsing(t *testing.T) {
	_, path, _, stop := testServer(t, os.Getuid()+1)
	defer stop()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	if err := protocol.WriteFrame(conn, json.RawMessage(`{"version":1,"id":"id","operation":"helper.capabilities","arguments":{}}`), 65536); err != nil {
		t.Fatal(err)
	}
	if _, err := protocol.ReadFrame(conn, 1<<20); err == nil {
		t.Fatal("unauthorized peer received a response")
	}
}
func TestExtraFrameIsRejected(t *testing.T) {
	_, path, _, stop := testServer(t, os.Getuid())
	defer stop()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	one := `{"version":1,"id":"id","operation":"helper.capabilities","arguments":{}}`
	var wire bytes.Buffer
	_ = protocol.WriteFrame(&wire, json.RawMessage(one), 65536)
	_ = protocol.WriteFrame(&wire, json.RawMessage(one), 65536)
	if _, err := conn.Write(wire.Bytes()); err != nil {
		t.Fatal(err)
	}
	b, err := protocol.ReadFrame(conn, 1<<20)
	if err != nil || !bytes.Contains(b, []byte(`"invalid_request"`)) {
		t.Fatalf("extra frame response %s %v", b, err)
	}
}
func TestFollowJournalEmitsHeartbeat(t *testing.T) {
	c := config.Defaults()
	c.AllowedPeerUID = os.Getuid()
	c.Limits.HeartbeatSeconds = 1
	c.Limits.JournalFollowSeconds = 3
	base := t.TempDir()
	c.Roots = map[string]string{"admin": filepath.Join(base, "a"), "runtime": filepath.Join(base, "r"), "distribution": filepath.Join(base, "d")}
	for _, p := range c.Roots {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(c.Roots["admin"], "x.network"), []byte("[Network]"), 0600); err != nil {
		t.Fatal(err)
	}
	reader, writer := io.Pipe()
	defer writer.Close()
	q := quadlet.Service{C: c, Runner: idleRunner{reader}, MapUnits: func(context.Context, map[string]string) (map[string]string, error) {
		return map[string]string{"admin\x00x.network": "x.service"}, nil
	}}
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	s := New(c, nil, q, "test", "test", io.Discard)
	done := make(chan error, 1)
	go func() {
		done <- s.journal(context.Background(), left, protocol.Request{ID: "id", Arguments: json.RawMessage(`{"root":"admin","sourceName":"x.network","lines":1,"follow":true}`)})
	}()
	_ = right.SetReadDeadline(time.Now().Add(2 * time.Second))
	b, err := protocol.ReadFrame(right, 1<<20)
	if err != nil || !bytes.Contains(b, []byte(`"journal.heartbeat"`)) {
		t.Fatalf("heartbeat %s %v", b, err)
	}
	_ = writer.Close()
	_ = right.SetReadDeadline(time.Now().Add(time.Second))
	for {
		terminal, err := protocol.ReadFrame(right, 1<<20)
		if err != nil {
			t.Fatalf("terminal response: %v", err)
		}
		if bytes.Contains(terminal, []byte(`"type":"result"`)) {
			break
		}
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("journal did not collect")
	}
}
