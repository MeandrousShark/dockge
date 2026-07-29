package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/louislam/dockge/quadlet-helper/internal/protocol"
)

const (
	DefaultRequestBytes  = 64 << 10
	DefaultResponseBytes = 1 << 20
)

type Limits struct {
	RequestBytes          uint32 `json:"requestBytes"`
	ResponseBytes         uint32 `json:"responseBytes"`
	RequestTimeoutSeconds int    `json:"requestTimeoutSeconds"`
	MaxConnections        int    `json:"maxConnections"`
	MaxJournalStreams     int    `json:"maxJournalStreams"`
	JournalHistoryRecords int    `json:"journalHistoryRecords"`
	JournalHistoryBytes   int    `json:"journalHistoryBytes"`
	JournalRecordBytes    int    `json:"journalRecordBytes"`
	JournalFollowSeconds  int    `json:"journalFollowSeconds"`
	HeartbeatSeconds      int    `json:"heartbeatSeconds"`
}

type Config struct {
	AllowedPeerUID int               `json:"allowedPeerUid"`
	Roots          map[string]string `json:"roots"`
	GeneratorPath  string            `json:"generatorPath"`
	SystemctlPath  string            `json:"systemctlPath"`
	JournalctlPath string            `json:"journalctlPath"`
	Limits         Limits            `json:"limits"`
}

func Defaults() Config {
	return Config{Roots: map[string]string{"admin": "/etc/containers/systemd", "runtime": "/run/containers/systemd", "distribution": "/usr/share/containers/systemd"}, GeneratorPath: "/usr/lib/systemd/system-generators/podman-system-generator", SystemctlPath: "/usr/bin/systemctl", JournalctlPath: "/usr/bin/journalctl", Limits: Limits{RequestBytes: DefaultRequestBytes, ResponseBytes: DefaultResponseBytes, RequestTimeoutSeconds: 5, MaxConnections: 16, MaxJournalStreams: 4, JournalHistoryRecords: 1000, JournalHistoryBytes: 1 << 20, JournalRecordBytes: 64 << 10, JournalFollowSeconds: 3600, HeartbeatSeconds: 15}}
}

func Load(path string) (Config, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return Config{}, err
	}
	if !fi.Mode().IsRegular() || fi.Mode()&os.ModeSymlink != 0 {
		return Config{}, errors.New("configuration must be a regular file")
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != 0 {
		return Config{}, errors.New("configuration must be root-owned")
	}
	if fi.Mode().Perm()&0o022 != 0 {
		return Config{}, errors.New("configuration must not be group/world writable")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	if err := protocol.ValidateJSON(b); err != nil {
		return Config{}, err
	}
	c := Defaults()
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil {
		return Config{}, err
	}
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

func (c Config) Validate() error {
	if c.AllowedPeerUID < 1 {
		return errors.New("allowedPeerUid must be a non-root UID")
	}
	if len(c.Roots) != 3 {
		return errors.New("roots must define exactly admin, runtime, distribution")
	}
	for _, name := range []string{"admin", "runtime", "distribution"} {
		p, ok := c.Roots[name]
		if !ok || !filepath.IsAbs(p) || filepath.Clean(p) != p {
			return fmt.Errorf("invalid %s root", name)
		}
	}
	for _, p := range []string{c.GeneratorPath, c.SystemctlPath, c.JournalctlPath} {
		if !filepath.IsAbs(p) {
			return errors.New("command paths must be absolute")
		}
	}
	l := c.Limits
	if l.RequestBytes == 0 || l.RequestBytes > DefaultRequestBytes || l.ResponseBytes == 0 || l.ResponseBytes > DefaultResponseBytes || l.RequestTimeoutSeconds < 1 || l.RequestTimeoutSeconds > 5 || l.MaxConnections < 1 || l.MaxConnections > 16 || l.MaxJournalStreams < 1 || l.MaxJournalStreams > 4 || l.JournalHistoryRecords < 1 || l.JournalHistoryRecords > 1000 || l.JournalHistoryBytes < 1 || l.JournalHistoryBytes > 1<<20 || l.JournalRecordBytes < 1 || l.JournalRecordBytes > 64<<10 || l.JournalFollowSeconds < 1 || l.JournalFollowSeconds > 3600 || l.HeartbeatSeconds < 1 || l.HeartbeatSeconds > 15 {
		return errors.New("limits exceed hard bounds")
	}
	return nil
}

// ValidateExecutables is used by offline self-test. Command ownership is
// checked before the root service starts, so a writable replacement cannot be
// selected by the configuration.
func (c Config) ValidateExecutables(binary string) error {
	paths := append([]string{binary}, c.GeneratorPath, c.SystemctlPath, c.JournalctlPath)
	for _, p := range paths {
		fi, err := os.Stat(p)
		if err != nil {
			return fmt.Errorf("executable %q: %w", p, err)
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || !fi.Mode().IsRegular() || st.Uid != 0 || fi.Mode().Perm()&0o022 != 0 {
			return fmt.Errorf("executable %q must be a root-owned non-writable regular file", p)
		}
	}
	return nil
}
