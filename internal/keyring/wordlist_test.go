package keyring

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"testing"
)

// canonicalWordlistSHA256 is the hash of bip-0039/english.txt as published, and
// as shipped by trezor/python-mnemonic. Recomputing it from the vendored slice
// is the whole point: it turns "somebody edited a word" from a class of bug
// that mints phrases no other tool can read into a failing test.
const canonicalWordlistSHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"

func TestWordlistIsCanonicalBIP39(t *testing.T) {
	if len(wordlist) != 2048 {
		t.Fatalf("wordlist has %d words, want 2048", len(wordlist))
	}
	// The published file is one word per line with a trailing newline.
	sum := sha256.Sum256([]byte(strings.Join(wordlist, "\n") + "\n"))
	if got := hex.EncodeToString(sum[:]); got != canonicalWordlistSHA256 {
		t.Fatalf("wordlist SHA-256 = %s, want %s -- the vendored copy has drifted from BIP-39", got, canonicalWordlistSHA256)
	}
}

func TestWordlistProperties(t *testing.T) {
	if !sort.StringsAreSorted(wordlist) {
		t.Error("wordlist is not sorted")
	}

	seen := make(map[string]int, len(wordlist))
	prefixes := make(map[string]string, len(wordlist))
	for i, w := range wordlist {
		if prev, dup := seen[w]; dup {
			t.Fatalf("word %q appears at both %d and %d", w, prev, i)
		}
		seen[w] = i

		if len(w) < 3 || len(w) > 8 {
			t.Errorf("word %q has length %d, outside the expected 3..8", w, len(w))
		}
		for _, r := range w {
			if r < 'a' || r > 'z' {
				t.Errorf("word %q contains %q, which is not a lowercase ASCII letter", w, r)
			}
		}

		// The property the whole transcription story rests on.
		p := prefixOf(w)
		if prev, clash := prefixes[p]; clash {
			t.Errorf("prefix %q is shared by %q and %q", p, prev, w)
		}
		prefixes[p] = w
	}
}

func TestLookupTablesCoverEveryWord(t *testing.T) {
	for i, w := range wordlist {
		if got, ok := wordIndex[w]; !ok || int(got) != i {
			t.Fatalf("wordIndex[%q] = %d, %v; want %d, true", w, got, ok, i)
		}
		if got, ok := prefixIndex[prefixOf(w)]; !ok || int(got) != i {
			t.Fatalf("prefixIndex[%q] = %d, %v; want %d, true", prefixOf(w), got, ok, i)
		}
	}
}
