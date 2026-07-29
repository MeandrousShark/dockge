package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"time"

	"github.com/louislam/dockge/quadlet-helper/internal/config"
	"github.com/louislam/dockge/quadlet-helper/internal/peer"
	"github.com/louislam/dockge/quadlet-helper/internal/protocol"
	"github.com/louislam/dockge/quadlet-helper/internal/quadlet"
)

type Server struct {
	Config        config.Config
	Listener      net.Listener
	Quadlet       quadlet.Service
	HelperVersion string
	BuildID       string
	logger        *log.Logger
	connections   chan struct{}
	streams       chan struct{}
	mu            sync.WaitGroup
}

func New(c config.Config, l net.Listener, q quadlet.Service, helperVersion, buildID string, audit io.Writer) *Server {
	if q.Runner == nil {
		q.Runner = quadlet.ExecRunner{}
	}
	if q.MapUnits == nil {
		q.MapUnits = q.GeneratorMap
	}
	if audit == nil {
		audit = os.Stderr
	}
	return &Server{Config: c, Listener: l, Quadlet: q, HelperVersion: helperVersion, BuildID: buildID, logger: log.New(audit, "", 0), connections: make(chan struct{}, c.Limits.MaxConnections), streams: make(chan struct{}, c.Limits.MaxJournalStreams)}
}

func (s *Server) Serve(ctx context.Context) error {
	for {
		conn, err := s.Listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				s.mu.Wait()
				return nil
			default:
			}
			if ne, ok := err.(net.Error); ok && ne.Temporary() {
				continue
			}
			return err
		}
		select {
		case s.connections <- struct{}{}:
			s.mu.Add(1)
			go func() { defer func() { <-s.connections; s.mu.Done() }(); s.handle(ctx, conn) }()
		default:
			conn.Close()
		}
	}
}

func (s *Server) handle(parent context.Context, conn net.Conn) {
	defer conn.Close()
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return
	}
	uid, pid, err := peer.Credentials(uc)
	if err != nil || uid != s.Config.AllowedPeerUID {
		s.audit(uid, pid, "", "", "unauthorized_peer", time.Time{})
		return
	}
	deadline := time.Now().Add(time.Duration(s.Config.Limits.RequestTimeoutSeconds) * time.Second)
	_ = conn.SetReadDeadline(deadline)
	b, err := protocol.ReadFrame(conn, s.Config.Limits.RequestBytes)
	if err != nil {
		s.audit(uid, pid, "", "", "invalid_request", time.Time{})
		return
	}
	// A short probe rejects a queued second request frame. It is deliberately
	// bounded well below the normal read deadline, so a compliant client need
	// not half-close before receiving its response.
	_ = conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	var probe [1]byte
	n, probeErr := conn.Read(probe[:])
	if n > 0 {
		s.write(conn, protocol.Failure("", "invalid_request", "extra request frame"))
		s.audit(uid, pid, "", "", "invalid_request", time.Time{})
		return
	}
	if probeErr == nil {
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	req, err := protocol.DecodeRequest(b)
	if err != nil {
		code := "invalid_request"
		if protocol.IsUnsupportedVersion(err) {
			code = "unsupported_version"
		}
		s.write(conn, protocol.Failure("", code, "invalid request"))
		s.audit(uid, pid, "", "", code, time.Time{})
		return
	}
	started := time.Now()
	duration := time.Duration(s.Config.Limits.RequestTimeoutSeconds) * time.Second
	if req.Operation == "quadlet.journal" {
		var journal struct {
			Follow bool `json:"follow"`
		}
		if protocol.DecodeArguments(req.Arguments, &journal) == nil && journal.Follow {
			duration = time.Duration(s.Config.Limits.JournalFollowSeconds) * time.Second
		}
	}
	ctx, cancel := context.WithTimeout(parent, duration)
	defer cancel()
	err = s.dispatch(ctx, conn, req)
	if err != nil {
		code := "internal"
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			code = "timeout"
		case errors.Is(err, context.Canceled):
			code = "cancelled"
		case errors.Is(err, os.ErrNotExist):
			code = "not_found"
		case errors.Is(err, errBad):
			code = "invalid_request"
		case errors.Is(err, quadlet.ErrInvalidResource):
			code = "invalid_resource"
		case errors.Is(err, errBusy):
			code = "busy"
		case errors.As(err, new(*codedError)):
			var coded *codedError
			errors.As(err, &coded)
			code = coded.code
		}
		s.write(conn, protocol.Failure(req.ID, code, safeMessage(code)))
		s.audit(uid, pid, req.ID, req.Operation, code, started)
		return
	}
	s.audit(uid, pid, req.ID, req.Operation, "ok", started)
}

var errBad = errors.New("bad request")
var errBusy = errors.New("journal streams busy")

type codedError struct{ code string }

func (e *codedError) Error() string { return e.code }

func safeMessage(code string) string {
	switch code {
	case "not_found":
		return "resource not found"
	case "timeout":
		return "operation timed out"
	case "cancelled":
		return "operation cancelled"
	case "invalid_request":
		return "invalid request"
	default:
		return "operation failed"
	}
}
func (s *Server) write(c net.Conn, r protocol.Response) error {
	_ = c.SetWriteDeadline(time.Now().Add(time.Duration(s.Config.Limits.RequestTimeoutSeconds) * time.Second))
	return protocol.WriteFrame(c, r, s.Config.Limits.ResponseBytes)
}
func (s *Server) event(c net.Conn, id string, seq int, event string, data any) error {
	_ = c.SetWriteDeadline(time.Now().Add(time.Duration(s.Config.Limits.RequestTimeoutSeconds) * time.Second))
	return protocol.WriteFrame(c, map[string]any{"version": protocol.Version, "id": id, "type": "event", "event": event, "sequence": seq, "data": data}, s.Config.Limits.ResponseBytes)
}

func (s *Server) dispatch(ctx context.Context, c net.Conn, r protocol.Request) error {
	switch r.Operation {
	case "helper.capabilities":
		var a struct{}
		if protocol.DecodeArguments(r.Arguments, &a) != nil {
			return errBad
		}
		return s.write(c, protocol.Result(r.ID, s.capabilities()))
	case "quadlet.list":
		var a struct{}
		if protocol.DecodeArguments(r.Arguments, &a) != nil {
			return errBad
		}
		x, err := s.Quadlet.List(ctx)
		if err != nil {
			return err
		}
		return s.write(c, protocol.Result(r.ID, map[string]any{"resources": x}))
	case "quadlet.status":
		var a struct {
			Root       string `json:"root"`
			SourceName string `json:"sourceName"`
		}
		if protocol.DecodeArguments(r.Arguments, &a) != nil {
			return errBad
		}
		x, err := s.Quadlet.Status(ctx, a.Root, a.SourceName)
		if err != nil {
			return err
		}
		return s.write(c, protocol.Result(r.ID, x))
	case "quadlet.journal":
		return s.journal(ctx, c, r)
	default:
		return &codedError{code: "unsupported_operation"}
	}
}
func (s *Server) capabilities() map[string]any {
	c := s.Config
	roots := []map[string]any{}
	for _, id := range []string{"admin", "runtime", "distribution"} {
		roots = append(roots, map[string]any{"id": id, "available": quadlet.RootAvailable(c.Roots[id])})
	}
	return map[string]any{"helperVersion": s.HelperVersion, "buildID": s.BuildID, "protocol": map[string]int{"min": protocol.Version, "max": protocol.Version, "active": protocol.Version}, "mode": "read-only", "operations": []string{"helper.capabilities", "quadlet.list", "quadlet.status", "quadlet.journal"}, "resourceTypes": []string{".container", ".network", ".volume"}, "roots": roots, "limits": c.Limits, "system": map[string]string{"generatorPath": c.GeneratorPath, "systemctlPath": c.SystemctlPath, "journalctlPath": c.JournalctlPath}}
}
func (s *Server) journal(ctx context.Context, c net.Conn, r protocol.Request) error {
	var a quadlet.JournalArgs
	if protocol.DecodeArguments(r.Arguments, &a) != nil {
		return errBad
	}
	select {
	case s.streams <- struct{}{}:
		defer func() { <-s.streams }()
	default:
		return errBusy
	}
	if a.Follow {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(s.Config.Limits.JournalFollowSeconds)*time.Second)
		defer cancel()
	}
	childCtx, cancelChild := context.WithCancel(ctx)
	reader, wait, _, err := s.Quadlet.JournalArgs(childCtx, a)
	if err != nil {
		cancelChild()
		return err
	}
	waited := false
	collect := func() {
		cancelChild()
		_ = reader.Close()
		if !waited {
			_ = wait()
			waited = true
		}
	}
	defer collect()
	records := make(chan quadlet.JournalRecord, 1)
	scanDone := make(chan error, 1)
	go func() {
		defer close(records)
		scanDone <- quadlet.ScanJournal(reader, s.Config.Limits.JournalHistoryRecords, s.Config.Limits.JournalRecordBytes, s.Config.Limits.JournalHistoryBytes, func(record quadlet.JournalRecord) error {
			select {
			case records <- record:
				return nil
			case <-childCtx.Done():
				return childCtx.Err()
			}
		})
	}()
	seq, recordCount := 0, 0
	var ticker *time.Ticker
	if a.Follow {
		ticker = time.NewTicker(time.Duration(s.Config.Limits.HeartbeatSeconds) * time.Second)
		defer ticker.Stop()
	}
	for {
		var heartbeat <-chan time.Time
		if ticker != nil {
			heartbeat = ticker.C
		}
		select {
		case record, ok := <-records:
			if !ok {
				records = nil
				continue
			}
			seq++
			recordCount++
			if err := s.event(c, r.ID, seq, "journal.record", record); err != nil {
				return err
			}
		case err = <-scanDone:
			// The scanner has closed records before this signal. Drain every
			// buffered record deterministically before a terminal result.
			if records != nil {
				for record := range records {
					seq++
					recordCount++
					if emitErr := s.event(c, r.ID, seq, "journal.record", record); emitErr != nil {
						return emitErr
					}
				}
			}
			records = nil
			if errors.Is(err, quadlet.ErrJournalBound) {
				cancelChild()
				err = nil
			}
			if err != nil {
				return err
			}
			goto collected
		case <-heartbeat:
			seq++
			if err := s.event(c, r.ID, seq, "journal.heartbeat", map[string]any{}); err != nil {
				return err
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
collected:
	cancelChild()
	if err = wait(); err != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	waited = true
	return s.write(c, protocol.Result(r.ID, map[string]any{"records": recordCount, "complete": true}))
}
func (s *Server) audit(uid, pid int, id, op, result string, started time.Time) {
	record := fmt.Sprintf(`{"timestamp":%q,"peerUid":%d,"peerPid":%d,"requestId":%q,"operation":%q,"result":%q`, time.Now().UTC().Format(time.RFC3339Nano), uid, pid, id, op, result)
	if !started.IsZero() {
		record += fmt.Sprintf(`,"durationMs":%d`, time.Since(started).Milliseconds())
	}
	s.logger.Print(record + "}")
}
