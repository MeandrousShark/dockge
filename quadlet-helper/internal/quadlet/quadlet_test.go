package quadlet

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/louislam/dockge/quadlet-helper/internal/config"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	base := t.TempDir()
	c := config.Defaults()
	c.Roots = map[string]string{"admin": filepath.Join(base, "admin"), "runtime": filepath.Join(base, "run"), "distribution": filepath.Join(base, "share")}
	for _, p := range c.Roots {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	return c
}
func TestInventoryNeverGuessesUnitNames(t *testing.T) {
	c := testConfig(t)
	if err := os.WriteFile(filepath.Join(c.Roots["admin"], "odd.network"), []byte("[Network]"), 0600); err != nil {
		t.Fatal(err)
	}
	s := Service{C: c, MapUnits: func(context.Context, map[string]string) (map[string]string, error) { return map[string]string{}, nil }}
	all, err := s.List(context.Background())
	if err != nil && !errors.Is(err, ErrJournalBound) {
		t.Fatal(err)
	}
	if all[0].UnitID != "" {
		t.Fatalf("guessed unit %q", all[0].UnitID)
	}
	if _, err := s.Find(context.Background(), "admin", "odd.network"); err == nil {
		t.Fatal("status/log selector accepted an unmapped source")
	}
}
func TestInventoryUsesGeneratorFacts(t *testing.T) {
	c := testConfig(t)
	if err := os.WriteFile(filepath.Join(c.Roots["admin"], "odd.network"), []byte("[Network]"), 0600); err != nil {
		t.Fatal(err)
	}
	s := Service{C: c, MapUnits: func(_ context.Context, paths map[string]string) (map[string]string, error) {
		if len(paths) != 1 {
			t.Fatal("wrong generator input")
		}
		return map[string]string{"admin\x00odd.network": "unrelated-derived.service"}, nil
	}}
	all, err := s.List(context.Background())
	if err != nil && !errors.Is(err, ErrJournalBound) {
		t.Fatal(err)
	}
	if all[0].UnitID != "unrelated-derived.service" {
		t.Fatalf("mapping=%q", all[0].UnitID)
	}
}
func TestGeneratorMapParsesPodmanDryRunSections(t *testing.T) {
	c := testConfig(t)
	path := filepath.Join(c.Roots["admin"], "odd.network")
	script := filepath.Join(t.TempDir(), "generator")
	output := "---/run/systemd/generator/nontrivial-network.service---\n[Unit]\nSourcePath=" + path + "\n"
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s' '"+output+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	c.GeneratorPath = script
	mapped, err := (Service{C: c}).GeneratorMap(context.Background(), map[string]string{"admin\x00odd.network": path})
	if err != nil && !errors.Is(err, ErrJournalBound) {
		t.Fatal(err)
	}
	if mapped["admin\x00odd.network"] != "nontrivial-network.service" {
		t.Fatalf("mapping %#v", mapped)
	}
}
func TestGeneratorMapSkipsRootsWithoutCandidates(t *testing.T) {
	c := testConfig(t)
	path := filepath.Join(c.Roots["admin"], "only.network")
	script := filepath.Join(t.TempDir(), "generator")
	output := "---/run/systemd/generator/only.service---\nSourcePath=" + path + "\n"
	// An invocation for any empty/missing root fails; the mapper must execute
	// only the root represented in its candidate map.
	if err := os.WriteFile(script, []byte("#!/bin/sh\ncase \"$QUADLET_UNIT_DIRS\" in \""+c.Roots["admin"]+"\") printf '%s' '"+output+"' ;; *) exit 77 ;; esac\n"), 0700); err != nil {
		t.Fatal(err)
	}
	c.GeneratorPath = script
	mapped, err := (Service{C: c}).GeneratorMap(context.Background(), map[string]string{"admin\x00only.network": path})
	if err != nil {
		t.Fatal(err)
	}
	if mapped["admin\x00only.network"] != "only.service" {
		t.Fatalf("mapping %#v", mapped)
	}
}
func TestRuntimePrecedenceShadowsAdminAndCannotBeSelected(t *testing.T) {
	c := testConfig(t)
	for _, root := range []string{"admin", "runtime"} {
		if err := os.WriteFile(filepath.Join(c.Roots[root], "same.network"), []byte("[Network]"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	s := Service{C: c, MapUnits: func(_ context.Context, paths map[string]string) (map[string]string, error) {
		return map[string]string{"admin\x00same.network": "admin.service", "runtime\x00same.network": "runtime.service"}, nil
	}}
	all, err := s.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range all {
		if e.Root == "admin" && e.ShadowedBy != "runtime" {
			t.Fatalf("admin precedence %#v", e)
		}
	}
	if _, err := s.Find(context.Background(), "admin", "same.network"); err == nil {
		t.Fatal("shadowed resource selectable")
	}
	if _, err := s.Find(context.Background(), "runtime", "same.network"); err != nil {
		t.Fatal(err)
	}
}
func TestSourceNameRejectsAllControls(t *testing.T) {
	for _, n := range []string{"bad\x01.container", "bad\x7f.container", "bad\n.container"} {
		if validSourceName(n) {
			t.Fatalf("accepted %q", n)
		}
	}
}
func TestLstatReportsSymlinkWithoutFollowing(t *testing.T) {
	c := testConfig(t)
	if err := os.Symlink("/etc/passwd", filepath.Join(c.Roots["admin"], "bad.container")); err != nil {
		t.Fatal(err)
	}
	all, err := Service{C: c}.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if all[0].FileKind != "symlink" || all[0].SHA256 != "" {
		t.Fatalf("unsafe inventory %#v", all[0])
	}
}
func TestJournalLimits(t *testing.T) {
	var got int
	err := ScanJournal(strings.NewReader(`{"MESSAGE":"abcdef"}`+"\n"), 1, 4, 3, func(JournalRecord) error { got++; return nil })
	if err != nil && !errors.Is(err, ErrJournalBound) {
		t.Fatal(err)
	}
	if got != 0 {
		t.Fatal("byte limit ignored")
	}
}

func TestOversizedJournalRecordIsMarkedAndNextRecordSurvives(t *testing.T) {
	input := `{"MESSAGE":"` + strings.Repeat("x", 200) + `"}` + "\n" + `{"MESSAGE":"ok"}` + "\n"
	var got []JournalRecord
	if err := ScanJournal(strings.NewReader(input), 2, 32, 1024, func(r JournalRecord) error { got = append(got, r); return nil }); err != nil && !errors.Is(err, ErrJournalBound) {
		t.Fatal(err)
	}
	if len(got) != 2 || !got[0].Truncated || got[1].Message != "ok" {
		t.Fatalf("records %#v", got)
	}
}
func TestRootSymlinkIsRejected(t *testing.T) {
	c := testConfig(t)
	if err := os.Remove(c.Roots["admin"]); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(c.Roots["runtime"], c.Roots["admin"]); err != nil {
		t.Fatal(err)
	}
	if _, err := (Service{C: c}).List(context.Background()); err == nil {
		t.Fatal("symlink root accepted")
	}
}
func TestListPassesRequestContextToMapper(t *testing.T) {
	c := testConfig(t)
	if err := os.WriteFile(filepath.Join(c.Roots["admin"], "x.network"), []byte("[Network]"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called := false
	s := Service{C: c, MapUnits: func(got context.Context, _ map[string]string) (map[string]string, error) {
		called = true
		if got.Err() == nil {
			t.Fatal("context was replaced")
		}
		return nil, got.Err()
	}}
	if _, err := s.List(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("context error=%v", err)
	}
	if !called {
		t.Fatal("mapper not called")
	}
}
func TestCommandOutputAndProcessGroupAreBounded(t *testing.T) {
	if _, err := runBounded(context.Background(), 16, "/bin/sh", "-c", "head -c 64 /dev/zero"); err == nil {
		t.Fatal("unbounded output accepted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := runBounded(ctx, 1024, "/bin/sh", "-c", "sleep 10 & wait")
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("group cancellation failed: %v", err)
	}
}
