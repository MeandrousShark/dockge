// Package quadlet contains the read-only source inventory and fixed command views.
package quadlet

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/louislam/dockge/quadlet-helper/internal/config"
)

const commandOutputLimit = 1 << 20

var supported = map[string]bool{".container": true, ".network": true, ".volume": true}
var ErrInvalidResource = errors.New("invalid resource")
var ErrJournalBound = errors.New("journal bound reached")

func validSourceName(s string) bool {
	if s == "" || len(s) > 128 || strings.ContainsAny(s, "/\\\x00") || s == "." || s == ".." {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

type InventoryEntry struct {
	Root       string `json:"root"`
	SourceName string `json:"sourceName"`
	Supported  bool   `json:"supported"`
	FileKind   string `json:"fileKind"`
	Size       int64  `json:"size,omitempty"`
	SHA256     string `json:"sha256,omitempty"`
	UnitID     string `json:"unitId,omitempty"`
	Managed    bool   `json:"managed"`
	ShadowedBy string `json:"shadowedBy,omitempty"`
}
type Status struct {
	Resource   InventoryEntry    `json:"resource"`
	Properties map[string]string `json:"properties"`
}
type JournalArgs struct {
	Root       string `json:"root"`
	SourceName string `json:"sourceName"`
	Lines      int    `json:"lines"`
	Follow     bool   `json:"follow"`
	Since      string `json:"since,omitempty"`
	Until      string `json:"until,omitempty"`
}
type JournalRecord struct {
	Message   string `json:"message"`
	Truncated bool   `json:"truncated,omitempty"`
}

type Runner interface {
	Run(context.Context, string, ...string) ([]byte, error)
	Start(context.Context, string, ...string) (io.ReadCloser, func() error, error)
}
type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, p string, args ...string) ([]byte, error) {
	return runBounded(ctx, commandOutputLimit, p, args...)
}
func (ExecRunner) Start(ctx context.Context, p string, args ...string) (io.ReadCloser, func() error, error) {
	cmd := exec.Command(p, args...)
	cmd.Env = cleanEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = &cappedBuffer{limit: commandOutputLimit}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, nil, err
	}
	return out, watchProcess(ctx, cmd), nil
}

func cleanEnv() []string { return []string{"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C"} }

type cappedBuffer struct {
	b        bytes.Buffer
	limit    int
	overflow bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if remaining := b.limit - b.b.Len(); remaining > 0 {
		if len(p) > remaining {
			b.b.Write(p[:remaining])
			b.overflow = true
		} else {
			b.b.Write(p)
		}
	} else if len(p) > 0 {
		b.overflow = true
	}
	return len(p), nil
}
func (b *cappedBuffer) Bytes() []byte { return b.b.Bytes() }

func runBounded(ctx context.Context, limit int, p string, args ...string) ([]byte, error) {
	cmd := exec.Command(p, args...)
	cmd.Env = cleanEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, stderr := &cappedBuffer{limit: limit}, &cappedBuffer{limit: limit}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	err := watchProcess(ctx, cmd)()
	if stdout.overflow || stderr.overflow {
		return nil, errors.New("command output limit exceeded")
	}
	if err != nil {
		return nil, err
	}
	return stdout.Bytes(), nil
}

// watchProcess turns context cancellation into a bounded process-group stop,
// then always waits for collection. This prevents generator/systemctl/journal
// descendants from escaping a disconnected client or deadline.
func watchProcess(ctx context.Context, cmd *exec.Cmd) func() error {
	done := make(chan struct{})
	var once sync.Once
	go func(pid int) {
		select {
		case <-ctx.Done():
			_ = syscall.Kill(-pid, syscall.SIGTERM)
			timer := time.NewTimer(500 * time.Millisecond)
			select {
			case <-timer.C:
				_ = syscall.Kill(-pid, syscall.SIGKILL)
			case <-done:
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		case <-done:
		}
	}(cmd.Process.Pid)
	return func() error { err := cmd.Wait(); once.Do(func() { close(done) }); return err }
}

type Service struct {
	C      config.Config
	Runner Runner
	// MapUnits is generator/systemd-derived mapping. It is intentionally the
	// only mapping source: absent generator facts mean absent unit metadata.
	MapUnits func(context.Context, map[string]string) (map[string]string, error)
}

var generatedHeader = regexp.MustCompile(`^---(.+\.service)---$`)

// GeneratorMap invokes only the configured generator in dry-run mode with an
// allowlisted environment. The parser relates a generated unit to the
// generator-emitted SourcePath fact; it never derives a name from a filename.
func (s Service) GeneratorMap(ctx context.Context, sources map[string]string) (map[string]string, error) {
	byPath := map[string]string{}
	for key, path := range sources {
		byPath[path] = key
	}
	result := map[string]string{}
	for _, root := range []string{"admin", "runtime", "distribution"} {
		hasCandidate := false
		prefix := root + "\x00"
		for key := range sources {
			if strings.HasPrefix(key, prefix) {
				hasCandidate = true
				break
			}
		}
		if !hasCandidate {
			continue
		}
		out, err := runGenerator(ctx, s.C.GeneratorPath, s.C.Roots[root])
		if err != nil {
			return nil, err
		}
		unit := ""
		for _, line := range strings.Split(string(out), "\n") {
			if header := generatedHeader.FindStringSubmatch(strings.TrimSuffix(line, "\r")); len(header) == 2 {
				unit = filepath.Base(header[1])
				continue
			}
			if unit != "" && strings.HasPrefix(line, "SourcePath=") {
				if key, ok := byPath[strings.TrimSpace(strings.TrimPrefix(line, "SourcePath="))]; ok {
					result[key] = unit
				}
			}
		}
	}
	return result, nil
}

func runGenerator(ctx context.Context, path, root string) ([]byte, error) {
	cmd := exec.Command(path, "--dryrun")
	cmd.Env = append(cleanEnv(), "QUADLET_UNIT_DIRS="+root)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	out, errout := &cappedBuffer{limit: commandOutputLimit}, &cappedBuffer{limit: commandOutputLimit}
	cmd.Stdout = out
	cmd.Stderr = errout
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	err := watchProcess(ctx, cmd)()
	if out.overflow || errout.overflow {
		return nil, errors.New("generator output limit exceeded")
	}
	if err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (s Service) List(ctx context.Context) ([]InventoryEntry, error) {
	entries := []InventoryEntry{}
	names := map[string]int{}
	for _, root := range []string{"admin", "runtime", "distribution"} {
		dir := s.C.Roots[root]
		rootInfo, rootErr := os.Lstat(dir)
		if errors.Is(rootErr, os.ErrNotExist) {
			continue
		}
		if rootErr != nil {
			return nil, rootErr
		}
		if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
			return nil, errors.New("unsafe logical root")
		}
		ds, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, d := range ds {
			e := InventoryEntry{Root: root, SourceName: d.Name(), Managed: false}
			ext := filepath.Ext(d.Name())
			e.Supported = supported[ext]
			fi, err := os.Lstat(filepath.Join(dir, d.Name()))
			if err != nil {
				continue
			}
			e.FileKind = kind(fi)
			if fi.Mode().IsRegular() {
				e.Size = fi.Size()
				if e.Supported && fi.Size() <= 256<<10 && regularSafe(fi) {
					sum, err := hashFile(filepath.Join(dir, d.Name()), fi)
					if err == nil {
						e.SHA256 = sum
					}
				}
			}
			entries = append(entries, e)
			names[d.Name()]++
		}
	}
	paths := map[string]string{}
	for _, e := range entries {
		if e.Supported && e.FileKind == "regular" && e.SHA256 != "" {
			paths[e.Root+"\x00"+e.SourceName] = filepath.Join(s.C.Roots[e.Root], e.SourceName)
		}
	}
	if s.MapUnits != nil {
		mapped, err := s.MapUnits(ctx, paths)
		if err != nil {
			return nil, err
		}
		for i := range entries {
			entries[i].UnitID = mapped[entries[i].Root+"\x00"+entries[i].SourceName]
		}
	}
	for i := range entries {
		if names[entries[i].SourceName] > 1 {
			entries[i].ShadowedBy = precedence(entries[i].Root, entries[i].SourceName, entries)
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Root == entries[j].Root {
			return entries[i].SourceName < entries[j].SourceName
		}
		return entries[i].Root < entries[j].Root
	})
	return entries, nil
}
func precedence(root, name string, entries []InventoryEntry) string {
	order := map[string]int{"runtime": 3, "admin": 2, "distribution": 1}
	best := ""
	for _, e := range entries {
		if e.SourceName == name && order[e.Root] > order[root] {
			if best == "" || order[e.Root] > order[best] {
				best = e.Root
			}
		}
	}
	return best
}
func kind(fi os.FileInfo) string {
	if fi.Mode()&os.ModeSymlink != 0 {
		return "symlink"
	}
	if fi.Mode().IsRegular() {
		return "regular"
	}
	if fi.IsDir() {
		return "directory"
	}
	return "irregular"
}
func regularSafe(fi os.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && st.Nlink == 1
}
func hashFile(path string, expected os.FileInfo) (string, error) {
	before, ok := expected.Sys().(*syscall.Stat_t)
	if !ok {
		return "", errors.New("unsupported source metadata")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !after.Mode().IsRegular() || !same(before, after.Sys().(*syscall.Stat_t)) {
		return "", errors.New("source changed or unsafe")
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	after, err = f.Stat()
	if err != nil || !same(before, after.Sys().(*syscall.Stat_t)) {
		return "", errors.New("source changed during read")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func same(a, b *syscall.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode && a.Nlink == b.Nlink
}
func (s Service) Find(ctx context.Context, root, name string) (InventoryEntry, error) {
	if !validSourceName(name) {
		return InventoryEntry{}, ErrInvalidResource
	}
	if _, ok := s.C.Roots[root]; !ok {
		return InventoryEntry{}, ErrInvalidResource
	}
	all, err := s.List(ctx)
	if err != nil {
		return InventoryEntry{}, err
	}
	for _, e := range all {
		if e.Root == root && e.SourceName == name {
			if !e.Supported || e.FileKind != "regular" || e.SHA256 == "" || e.UnitID == "" || e.ShadowedBy != "" {
				return InventoryEntry{}, ErrInvalidResource
			}
			return e, nil
		}
	}
	return InventoryEntry{}, os.ErrNotExist
}

var properties = []string{"Id", "Description", "LoadState", "ActiveState", "SubState", "UnitFileState", "FragmentPath", "SourcePath", "Result", "ExecMainCode", "ExecMainStatus", "ActiveEnterTimestamp", "InactiveEnterTimestamp"}

func (s Service) Status(ctx context.Context, root, name string) (Status, error) {
	e, err := s.Find(ctx, root, name)
	if err != nil {
		return Status{}, err
	}
	args := append([]string{"show", "--no-pager", "--property=" + strings.Join(properties, ","), "--"}, e.UnitID)
	out, err := s.Runner.Run(ctx, s.C.SystemctlPath, args...)
	if err != nil {
		return Status{}, err
	}
	got := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if ok && contains(properties, k) {
			got[k] = sanitize(v, 1024)
		}
	}
	return Status{Resource: e, Properties: got}, nil
}
func contains(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}
func sanitize(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r < ' ' && r != '\t' {
			return -1
		}
		return r
	}, s)
	if len(s) > max {
		return s[:max]
	}
	return s
}
func (s Service) JournalArgs(ctx context.Context, a JournalArgs) (io.ReadCloser, func() error, string, error) {
	if a.Lines < 1 || a.Lines > s.C.Limits.JournalHistoryRecords || (a.Since != "" && !validTime(a.Since)) || (a.Until != "" && !validTime(a.Until)) {
		return nil, nil, "", errors.New("invalid journal arguments")
	}
	e, err := s.Find(ctx, a.Root, a.SourceName)
	if err != nil {
		return nil, nil, "", err
	}
	args := []string{"--no-pager", "--output=json", "--unit=" + e.UnitID, "--lines=" + fmt.Sprint(a.Lines)}
	if a.Since != "" {
		args = append(args, "--since", a.Since)
	}
	if a.Until != "" {
		args = append(args, "--until", a.Until)
	}
	if a.Follow {
		args = append(args, "--follow")
	}
	r, wait, err := s.Runner.Start(ctx, s.C.JournalctlPath, args...)
	return r, wait, e.UnitID, err
}
func validTime(s string) bool { _, err := time.Parse(time.RFC3339, s); return err == nil }
func ParseJournalLine(line []byte, max int) JournalRecord {
	var obj struct {
		Message string `json:"MESSAGE"`
	}
	if json.Unmarshal(line, &obj) != nil {
		return JournalRecord{Message: "[unparseable journal record]"}
	}
	obj.Message = sanitize(obj.Message, max)
	return JournalRecord{Message: obj.Message, Truncated: len(obj.Message) >= max}
}
func ScanJournal(r io.Reader, limit, recordLimit, byteLimit int, emit func(JournalRecord) error) error {
	br := bufio.NewReaderSize(r, min(recordLimit+1, 64<<10))
	count, used := 0, 0
	for {
		line, truncated, err := readJournalLine(br, recordLimit)
		if len(line) > 0 && count < limit {
			record := ParseJournalLine(line, recordLimit)
			if truncated {
				record = JournalRecord{Message: "[journal record truncated]", Truncated: true}
			}
			used += len(record.Message)
			if used > byteLimit {
				return ErrJournalBound
			}
			if emitErr := emit(record); emitErr != nil {
				return emitErr
			}
			count++
		}
		if count >= limit {
			return ErrJournalBound
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// RootAvailable uses lstat so a root symlink can never be advertised as a
// readable logical root to a client.
func RootAvailable(path string) bool {
	fi, err := os.Lstat(path)
	return err == nil && fi.IsDir() && fi.Mode()&os.ModeSymlink == 0
}

// readJournalLine retains at most limit bytes yet consumes through the next
// newline, so one malicious record cannot poison the remainder of a stream.
func readJournalLine(br *bufio.Reader, limit int) ([]byte, bool, error) {
	var kept []byte
	truncated := false
	for {
		part, err := br.ReadSlice('\n')
		if len(part) > 0 {
			remaining := limit - len(kept)
			if remaining > 0 {
				take := len(part)
				if take > remaining {
					take = remaining
					truncated = true
				}
				kept = append(kept, part[:take]...)
			} else {
				truncated = true
			}
		}
		if err == nil {
			return kept, truncated, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			truncated = true
			continue
		}
		return kept, truncated, err
	}
}
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
