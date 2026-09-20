package keyring

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"strings"
	"unicode"
)

// A recovery phrase is eight words from the BIP-39 list.
//
// # Why eight and not twelve
//
// Eight words carry 88 bits: ten bytes of entropy and one checksum byte, which
// is exactly 8 x 11 bits with no padding. Bitcoin uses twelve because BIP-39
// stretches a phrase with PBKDF2 at 2048 rounds, which is nearly free to
// attack, so it needs 128 bits to compensate. We feed the phrase to the same
// Argon2id the login password uses -- 64 MiB, three passes -- which is worth
// far more than the twenty bits of difference. 80 bits behind a memory-hard KDF
// is millions of core-years; the marginal bit is worth nothing next to the
// phrase being short enough to fit on one printed line and be transcribed
// without error.
//
// # Why a checksum at all
//
// Because the failure we are actually guarding against is not an attacker, it
// is a person retyping eight words off a photograph at the worst moment of
// their week. Without a checksum, one wrong word is indistinguishable from the
// wrong phrase, and somebody concludes their history is gone when it is a typo.
//
// Most transcription errors never reach the checksum: a mistyped word is
// usually not in the list at all, and we can name it and suggest the word it
// was meant to be. The checksum catches the residue -- a real word swapped for
// another real word, or two words transposed -- at one in 256.
//
// # What derives the key
//
// The ten entropy bytes, not the printed words. So a phrase typed as four-letter
// prefixes unwraps the same keyslot as one typed in full, and neither the
// spacing nor the case a person used can change the answer.
const (
	// PhraseWords is the length of a recovery phrase.
	PhraseWords = 8
	// phraseEntropyBytes is the key material inside it.
	phraseEntropyBytes = 10
	// phraseTotalBytes is entropy plus the single checksum byte.
	phraseTotalBytes = phraseEntropyBytes + 1
)

// Phrase is a parsed recovery phrase. The zero value is not usable.
type Phrase struct {
	entropy [phraseEntropyBytes]byte
}

// ErrPhraseChecksum means every word was real but the phrase does not check
// out, so one of them is wrong or two are swapped.
var ErrPhraseChecksum = errors.New("that is eight real words, but they do not check out as a recovery phrase -- one is probably transcribed wrong, or two are swapped")

// WrongLengthError reports a phrase that is not eight words.
type WrongLengthError struct{ Got int }

func (e *WrongLengthError) Error() string {
	return fmt.Sprintf("a recovery phrase is %d words; this is %d", PhraseWords, e.Got)
}

// UnknownWordError names the word that is not in the list, and what it most
// likely was. Naming the position matters: it is the difference between "check
// your phrase" and "look at the third word".
type UnknownWordError struct {
	Position   int // 1-based, as a person counts
	Word       string
	Suggestion string // "" when nothing is close enough to guess
}

func (e *UnknownWordError) Error() string {
	if e.Suggestion != "" {
		return fmt.Sprintf("word %d, %q, is not in the recovery wordlist -- did you mean %q?", e.Position, e.Word, e.Suggestion)
	}
	return fmt.Sprintf("word %d, %q, is not in the recovery wordlist", e.Position, e.Word)
}

// prefixOf is the four-letter key a word is uniquely identified by. Words
// shorter than four letters are their own prefix; the list's shortest is three.
func prefixOf(w string) string {
	if len(w) <= 4 {
		return w
	}
	return w[:4]
}

// NewPhrase mints a fresh recovery phrase from the system CSPRNG.
func NewPhrase() (Phrase, error) {
	var p Phrase
	if _, err := rand.Read(p.entropy[:]); err != nil {
		return Phrase{}, fmt.Errorf("could not read random bytes for a recovery phrase: %w", err)
	}
	return p, nil
}

// checksumByte is the first byte of SHA-256 over the entropy.
func checksumByte(entropy []byte) byte {
	sum := sha256.Sum256(entropy)
	return sum[0]
}

// Words renders the phrase as the eight words to show the user.
func (p Phrase) Words() []string {
	var packed [phraseTotalBytes]byte
	copy(packed[:], p.entropy[:])
	packed[phraseEntropyBytes] = checksumByte(p.entropy[:])

	out := make([]string, PhraseWords)
	for i := range out {
		out[i] = wordlist[bits11(packed[:], i)]
	}
	return out
}

// String is the phrase as a person would write it down.
func (p Phrase) String() string { return strings.Join(p.Words(), " ") }

// Secret is the key material Argon2id stretches. Deliberately not the printed
// words: prefixes and full words must reach the same keyslot.
func (p Phrase) Secret() []byte {
	out := make([]byte, phraseEntropyBytes)
	copy(out, p.entropy[:])
	return out
}

// bits11 reads the i'th 11-bit big-endian group out of packed.
func bits11(packed []byte, i int) uint16 {
	start := i * 11
	var v uint16
	for b := 0; b < 11; b++ {
		bit := start + b
		set := (packed[bit/8]>>(7-uint(bit%8)))&1 == 1
		v <<= 1
		if set {
			v |= 1
		}
	}
	return v
}

// setBits11 writes an 11-bit group back.
func setBits11(packed []byte, i int, v uint16) {
	start := i * 11
	for b := 0; b < 11; b++ {
		if (v>>(10-uint(b)))&1 == 1 {
			bit := start + b
			packed[bit/8] |= 1 << (7 - uint(bit%8))
		}
	}
}

// ParsePhrase reads a phrase a person typed.
//
// Forgiving about everything that is not the words themselves -- case, runs of
// spaces, line breaks off a printout, commas, and the "1." numbering someone
// adds when copying it into a note -- because none of that is information. Any
// character that is not a letter separates words.
func ParsePhrase(s string) (Phrase, error) {
	fields := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r)
	})
	if len(fields) != PhraseWords {
		return Phrase{}, &WrongLengthError{Got: len(fields)}
	}

	var packed [phraseTotalBytes]byte
	for i, f := range fields {
		idx, ok := wordIndex[f]
		if !ok {
			// A clipped word off a photo is still unambiguous: the list has
			// unique four-letter prefixes, which is most of why we use it.
			//
			// Clipped, though -- not merely starting the same way. What was
			// typed has to be a genuine prefix of the word it resolves to, or
			// "spirt" quietly becomes "spirit" and so does "spiral", and the
			// typo we could have named and corrected is instead swallowed and
			// left for the checksum to catch one time in 256.
			if cand, found := prefixIndex[prefixOf(f)]; found && strings.HasPrefix(wordlist[cand], f) {
				idx, ok = cand, true
			}
		}
		if !ok {
			return Phrase{}, &UnknownWordError{Position: i + 1, Word: f, Suggestion: nearestWord(f)}
		}
		setBits11(packed[:], i, idx)
	}

	entropy := packed[:phraseEntropyBytes]
	if subtle.ConstantTimeByteEq(packed[phraseEntropyBytes], checksumByte(entropy)) != 1 {
		return Phrase{}, ErrPhraseChecksum
	}

	var p Phrase
	copy(p.entropy[:], entropy)
	return p, nil
}

// nearestWord guesses what a mistyped word was meant to be, or returns "" when
// nothing is close enough to be worth saying out loud.
//
// This is the suggested-correction side of failing early, not the hiding side:
// we still refuse the phrase. We just refuse it with the answer attached,
// because "did you mean nurse?" ends the problem and "invalid phrase" starts an
// evening of dread.
func nearestWord(w string) string {
	const maxDistance = 2
	best, bestD, tied := "", maxDistance+1, false
	for _, cand := range wordlist {
		// Length alone rules out most of the list before touching the matrix.
		if abs(len(cand)-len(w)) > maxDistance {
			continue
		}
		d := editDistance(w, cand, bestD)
		switch {
		case d < bestD:
			best, bestD, tied = cand, d, false
		case d == bestD:
			tied = true
		}
	}
	// A tie is not a suggestion. Pointing at one of two equally likely words is
	// worse than pointing at neither, because it gets followed.
	if bestD > maxDistance || tied {
		return ""
	}
	return best
}

// editDistance is Levenshtein, abandoning once every cell exceeds limit.
func editDistance(a, b string, limit int) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		row := cur[0]
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min3(cur[j-1]+1, prev[j]+1, prev[j-1]+cost)
			if cur[j] < row {
				row = cur[j]
			}
		}
		if row > limit {
			return limit + 1
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
