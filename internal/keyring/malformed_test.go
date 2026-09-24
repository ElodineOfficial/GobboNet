package keyring

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMalformedSlotIsAnErrorNotAPanic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.keyring")
	_, _, err := Create(path, "password")
	if err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(path)
	for _, mutate := range []func(*file){
		func(f *file) { f.Slots[0].KDF.Time = 0 },
		func(f *file) { f.Slots[0].KDF.Memory = 1 << 31 },
		func(f *file) { f.Slots[0].KDF.Threads = 0 },
		func(f *file) { f.Slots[0].Nonce = b64([]byte("short")) },
	} {
		var f file
		json.Unmarshal(original, &f)
		mutate(&f)
		raw, _ := json.Marshal(f)
		os.WriteFile(path, raw, 0600)
		if _, err := UnlockPassword(path, "password"); err == nil {
			t.Fatal("malformed slot accepted")
		}
	}
}

func TestMalformedEnvelopeNonceIsAnError(t *testing.T) {
	k, _, err := Create(filepath.Join(t.TempDir(), "state.keyring"), "password")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := k.Seal([]byte(`{}`))
	var e envelope
	json.Unmarshal(raw, &e)
	e.Nonce = b64([]byte("short"))
	raw, _ = json.Marshal(e)
	if _, err := k.Unseal(raw); err == nil {
		t.Fatal("malformed nonce accepted")
	}
}
