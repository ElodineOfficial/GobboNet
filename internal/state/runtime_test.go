package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
)

// Compare with the former encoder, including unknown fields, escaping and
// legacy shapes. Versions must not change simply because encoding got cheaper.
func TestStreamingDocumentMatchesCanonicalEncoding(t *testing.T) {
	for _, raw := range []string{
		`{}`, `{"threads":null}`, `{"threads":[]}`, `{"future":{"x":9007199254740993,"s":"<>&"},"threads":[ {"id":"a","messages":[{"content":"hello\\nworld"}]} ]}`,
		`{"z": [1, 2], "<key>":"雪", "threads":[null,{}, {"id":"a","unknown":{"x":1,"x":2}}]}`,
	} {
		d, err := parseDocument([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		old := make(map[string]json.RawMessage)
		for k, v := range d.keys {
			old[k] = v
		}
		if d.hadThreads || len(d.threads) > 0 {
			old["threads"], err = marshalJSON(d.threads)
			if err != nil {
				t.Fatal(err)
			}
			if d.threads == nil {
				old["threads"] = []byte("[]")
			}
		}
		want, err := marshalJSON(old)
		if err != nil {
			t.Fatal(err)
		}
		got, err := d.marshal()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("canonical mismatch: %s != %s", got, want)
		}
		tag, err := d.etag()
		if err != nil {
			t.Fatal(err)
		}
		if tag != etagOf(want) {
			t.Fatalf("etag mismatch: %s", tag)
		}
	}
}

type brokenWriter struct{}

func (brokenWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }
func TestDocumentWriterFailure(t *testing.T) {
	d, _ := parseDocument([]byte(`{"threads":[]}`))
	if d.writeJSON(brokenWriter{}) == nil {
		t.Fatal("writer error swallowed")
	}
}
