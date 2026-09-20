package state

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// document is a state file decoded exactly far enough to address one
// conversation, and not one step further.
//
// The whole design of this package used to rest on never parsing the body:
// json.Valid, then store the bytes. Addressing a single thread costs that
// property, so the replacement is to be precise about what is given up. The
// server learns three facts and no more:
//
//	threads              is an array
//	threads[i].id        is a string
//	threads[i].messages  is an array
//
// Every other top-level key, and every other field inside a thread, is held as
// json.RawMessage and re-emitted as-is. A key this build has never heard of
// survives a patch untouched, which is what lets an older server hold a newer
// client's state without corrupting it.
//
// "As-is" is worth being exact about, because the guarantee is what the rest of
// this package is built on. Raw values are never decoded, so they are never
// re-interpreted: no number goes through float64 and back, which a
// map[string]any decode would have done silently to every timestamp and every
// sampler value in the file. What does change is insignificant whitespace,
// which encoding/json compacts on the way out. Structure, keys, order within
// arrays and every literal survive; indentation does not.
//
// This is the same shallow decode internal/debugreport/data.go already uses,
// and for the same reason its comment records: a struct of typed slices failed
// the whole document on one unexpected field -- `extensions` is an object where
// its neighbours are arrays -- and reported an install with 47 messages as
// empty.
type document struct {
	// keys holds every top-level key except threads, values verbatim.
	keys map[string]json.RawMessage
	// threads holds each conversation's bytes verbatim.
	threads []json.RawMessage
	// hadThreads records whether the file carried a threads key at all, so a
	// document that never had one does not silently grow one on an unrelated
	// meta write.
	hadThreads bool
}

// parseDocument decodes a stored state file.
func parseDocument(raw []byte) (*document, error) {
	d := &document{keys: map[string]json.RawMessage{}}
	if len(raw) == 0 {
		return d, nil
	}
	if err := json.Unmarshal(raw, &d.keys); err != nil {
		return nil, fmt.Errorf("state is not a JSON object: %w", err)
	}
	rawThreads, ok := d.keys["threads"]
	if !ok {
		return d, nil
	}
	delete(d.keys, "threads")
	d.hadThreads = true
	// A JSON null decodes to a nil slice without error, which is the same thing
	// an empty list means here.
	if err := json.Unmarshal(rawThreads, &d.threads); err != nil {
		return nil, fmt.Errorf("threads is not an array: %w", err)
	}
	return d, nil
}

// marshalJSON encodes without HTML escaping.
//
// encoding/json's package-level Marshal rewrites <, > and & as six-character
// unicode escapes, which exists for JSON embedded in a script tag. Nothing here
// is embedded in one:
// this is served as application/json and read by fetch(). Leaving it on would
// rewrite every angle bracket in every message the first time a conversation
// was patched, inflating the file and making a diff between two versions
// useless. JSON.stringify() in the browser does not escape either, so this is
// what the document already contained.
func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	// Encode appends a newline; the stored document is a single value.
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// marshal re-emits the document.
//
// Go sorts map keys, so the ~15 top-level keys come back alphabetised rather
// than in the order the browser sent them. That, plus whitespace compaction, is
// the visible cost of patching: the file is no longer byte-identical to the
// last upload, though every value in it is unchanged and untouched threads are
// re-emitted exactly as they were stored.
func (d *document) marshal() ([]byte, error) {
	out := make(map[string]json.RawMessage, len(d.keys)+1)
	for k, v := range d.keys {
		out[k] = v
	}
	if d.hadThreads || len(d.threads) > 0 {
		encoded, err := marshalJSON(d.threads)
		if err != nil {
			return nil, err
		}
		if d.threads == nil {
			// Marshalling a nil slice gives "null"; an empty conversation list
			// is [], and the client's loader distinguishes the two.
			encoded = []byte("[]")
		}
		out["threads"] = encoded
	}
	return marshalJSON(out)
}

// find returns the index of the thread with this id, or -1.
func (d *document) find(id string) int {
	for i, t := range d.threads {
		if got, ok := threadID(t); ok && got == id {
			return i
		}
	}
	return -1
}

// threadID reads one field out of a conversation.
//
// A thread whose id is missing, empty or not a string is not addressable and is
// reported as such rather than guessed at. It still round-trips verbatim
// through every patch -- it simply cannot be the target of one.
func threadID(raw json.RawMessage) (string, bool) {
	var probe struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.ID == "" {
		return "", false
	}
	return probe.ID, true
}

// messageCount returns the number of messages in a thread, or -1 when the
// field is missing or is not an array. -1 follows debugreport's convention:
// "could not tell" is distinct from "none".
func messageCount(raw json.RawMessage) int {
	var probe struct {
		Messages *[]json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.Messages == nil {
		return -1
	}
	return len(*probe.Messages)
}

// appendMessages returns the thread with extra appended to its messages array,
// along with the resulting message count.
//
// The thread is re-encoded, so its keys come back alphabetised the same way the
// document's do. Every value, including every existing message, is carried as
// raw bytes.
func appendMessages(thread json.RawMessage, extra []json.RawMessage) (json.RawMessage, int, error) {
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(thread, &fields); err != nil {
		return nil, 0, fmt.Errorf("thread is not a JSON object: %w", err)
	}
	var msgs []json.RawMessage
	if raw, ok := fields["messages"]; ok {
		if err := json.Unmarshal(raw, &msgs); err != nil {
			return nil, 0, errors.New("thread's messages field is not an array")
		}
	}
	msgs = append(msgs, extra...)
	encoded, err := marshalJSON(msgs)
	if err != nil {
		return nil, 0, err
	}
	fields["messages"] = encoded
	out, err := marshalJSON(fields)
	if err != nil {
		return nil, 0, err
	}
	return out, len(msgs), nil
}

// etagOf is the version token for a byte slice.
//
// Server-issued and opaque: the client only ever echoes back what it was last
// handed, so the two sides never have to agree on a canonical serialisation.
// Truncated to 128 bits because this is a change detector, not a signature, and
// a short token keeps the header small.
//
// Hashing became affordable when the unit stopped being the whole file -- over
// a multi-megabyte history on every request it would not have been.
func etagOf(b []byte) string {
	sum := sha256.Sum256(b)
	return `"` + hex.EncodeToString(sum[:16]) + `"`
}

// loadDocument reads and parses a state file. A missing file is not an error:
// it reports exists=false and an empty document, because creating the first
// conversation on a fresh server is an ordinary thing to do.
func loadDocument(t target) (d *document, info os.FileInfo, exists bool, err error) {
	info, statErr := os.Stat(t.path)
	if statErr != nil || !info.Mode().IsRegular() {
		if statErr != nil && !os.IsNotExist(statErr) {
			return nil, nil, false, statErr
		}
		empty, _ := parseDocument(nil)
		return empty, nil, false, nil
	}
	raw, err := t.read()
	if err != nil {
		return nil, nil, false, err
	}
	d, err = parseDocument(raw)
	if err != nil {
		return nil, nil, true, err
	}
	return d, info, true, nil
}

// saveDocument re-encodes and writes the document, returning the new mtime.
func saveDocument(t target, d *document) (int64, error) {
	body, err := d.marshal()
	if err != nil {
		return 0, err
	}
	if err := t.write(body); err != nil {
		return 0, err
	}
	info, err := os.Stat(t.path)
	if err != nil {
		return 0, err
	}
	return mtimeMS(info), nil
}
