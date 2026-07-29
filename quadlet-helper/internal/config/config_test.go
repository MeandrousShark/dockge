package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateRejectsUnsafeBoundsAndRoots(t *testing.T) {
	c := Defaults()
	c.AllowedPeerUID = 1000
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.Limits.RequestBytes = DefaultRequestBytes + 1
	if err := c.Validate(); err == nil {
		t.Fatal("raised request cap accepted")
	}
	c = Defaults()
	c.AllowedPeerUID = 1000
	c.Roots["admin"] = "relative"
	if err := c.Validate(); err == nil {
		t.Fatal("relative root accepted")
	}
}
func TestLoadRejectsUnknownAndDuplicateFields(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "config.json")
	for _, raw := range []string{`{"allowedPeerUid":1000,"unexpected":true}`, `{"allowedPeerUid":1000,"allowedPeerUid":1000}`} {
		if err := os.WriteFile(p, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(p); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
