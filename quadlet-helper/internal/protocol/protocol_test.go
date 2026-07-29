package protocol

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

func frame(s string) []byte {
	var h [4]byte
	binary.BigEndian.PutUint32(h[:], uint32(len(s)))
	return append(h[:], s...)
}
func TestDecodeRequestRejectsAdversarialJSON(t *testing.T) {
	valid := `{"version":1,"id":"safe_1","operation":"helper.capabilities","arguments":{}}`
	if _, err := DecodeRequest([]byte(valid)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		`{"version":1,"version":1,"id":"safe","operation":"x","arguments":{}}`,
		`{"version":1,"id":"safe","operation":"x","arguments":{"x":1,"x":2}}`,
		`{"version":1,"id":"bad space","operation":"x","arguments":{}}`,
		`{"version":1,"id":"safe","operation":"x","arguments":{}} {}`,
		`{"version":1,"id":"safe","operation":"x","arguments":[]}`,
	} {
		if _, err := DecodeRequest([]byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
func TestFramesAreBoundedAndExact(t *testing.T) {
	if _, err := ReadFrame(bytes.NewReader(frame(`{}`)), 1); err == nil {
		t.Fatal("oversize frame accepted")
	}
	if _, err := ReadFrame(bytes.NewReader([]byte{0, 0, 0, 3, '{'}), 64); err == nil {
		t.Fatal("truncated frame accepted")
	}
	if _, err := ReadFrame(bytes.NewReader([]byte{0, 0, 0, 2, 0xff, 0xff}), 64); err == nil {
		t.Fatal("invalid utf8 accepted")
	}
}
func TestNestingLimit(t *testing.T) {
	raw := strings.Repeat("[", MaxNesting+2) + strings.Repeat("]", MaxNesting+2)
	if err := ValidateJSON([]byte(raw)); err == nil {
		t.Fatal("deep json accepted")
	}
}
