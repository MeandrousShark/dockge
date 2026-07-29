// Package protocol implements the deliberately small helper wire protocol.
package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"unicode/utf8"
)

const Version = 1

const MaxNesting = 32

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type Request struct {
	Version   int             `json:"version"`
	ID        string          `json:"id"`
	Operation string          `json:"operation"`
	Arguments json.RawMessage `json:"arguments"`
}

type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type Response struct {
	Version  int    `json:"version"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	OK       bool   `json:"ok"`
	Result   any    `json:"result,omitempty"`
	Error    *Error `json:"error,omitempty"`
	Event    string `json:"event,omitempty"`
	Sequence int    `json:"sequence,omitempty"`
	Data     any    `json:"data,omitempty"`
}

func Result(id string, result any) Response {
	return Response{Version: Version, ID: id, Type: "result", OK: true, Result: result}
}
func Failure(id, code, message string) Response {
	return Response{Version: Version, ID: id, Type: "error", OK: false, Error: &Error{Code: code, Message: message}}
}

// ReadFrame reads exactly one bounded, big-endian length-prefixed JSON value.
func ReadFrame(r io.Reader, max uint32) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > max {
		return nil, fmt.Errorf("invalid frame length")
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	if !utf8.Valid(payload) {
		return nil, errors.New("invalid utf-8")
	}
	return payload, nil
}

func WriteFrame(w io.Writer, value any, max uint32) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(b) == 0 || uint64(len(b)) > uint64(max) {
		return errors.New("response frame too large")
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(b)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

// DecodeRequest rejects duplicate keys, unknown envelope fields, nesting abuse,
// trailing JSON, and argument values which are not objects.
func DecodeRequest(b []byte) (Request, error) {
	if err := ValidateJSON(b); err != nil {
		return Request{}, err
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var req Request
	if err := dec.Decode(&req); err != nil {
		return Request{}, fmt.Errorf("invalid request: %w", err)
	}
	if req.Version != Version {
		return Request{}, errVersion(req.Version)
	}
	if !idPattern.MatchString(req.ID) {
		return Request{}, errors.New("invalid request id")
	}
	if req.Operation == "" {
		return Request{}, errors.New("missing operation")
	}
	if len(req.Arguments) == 0 || !isObject(req.Arguments) {
		return Request{}, errors.New("arguments must be an object")
	}
	return req, nil
}

type versionError int

func (e versionError) Error() string      { return "unsupported protocol version" }
func errVersion(v int) error              { return versionError(v) }
func IsUnsupportedVersion(err error) bool { _, ok := err.(versionError); return ok }

// DecodeArguments applies the same duplicate-key and unknown-field policy to
// an operation schema as is applied to the envelope.
func DecodeArguments(raw json.RawMessage, target any) error {
	if !isObject(raw) {
		return errors.New("arguments must be an object")
	}
	if err := ValidateJSON(raw); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	return d.Decode(target)
}

func isObject(b []byte) bool {
	for _, c := range b {
		if c == ' ' || c == '\n' || c == '\t' || c == '\r' {
			continue
		}
		return c == '{'
	}
	return false
}

// ValidateJSON parses every token before unmarshalling, which lets us reject
// duplicate keys at every object depth (encoding/json otherwise accepts them).
func ValidateJSON(b []byte) error {
	if !utf8.Valid(b) {
		return errors.New("invalid utf-8")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if err := scanValue(d, 0); err != nil {
		return fmt.Errorf("invalid json: %w", err)
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing json data")
	}
	return nil
}

func scanValue(d *json.Decoder, depth int) error {
	if depth > MaxNesting {
		return errors.New("excessive nesting")
	}
	tok, err := d.Token()
	if err != nil {
		return err
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		keys := map[string]struct{}{}
		for d.More() {
			k, err := d.Token()
			if err != nil {
				return err
			}
			name, ok := k.(string)
			if !ok {
				return errors.New("object key is not a string")
			}
			if _, exists := keys[name]; exists {
				return errors.New("duplicate json key")
			}
			keys[name] = struct{}{}
			if err := scanValue(d, depth+1); err != nil {
				return err
			}
		}
		_, err := d.Token()
		return err
	case '[':
		for d.More() {
			if err := scanValue(d, depth+1); err != nil {
				return err
			}
		}
		_, err := d.Token()
		return err
	default:
		return errors.New("invalid delimiter")
	}
}
