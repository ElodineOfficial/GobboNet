package keyring

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestPhraseRoundTrip(t *testing.T) {
	for i := 0; i < 200; i++ {
		p, err := NewPhrase()
		if err != nil {
			t.Fatalf("NewPhrase: %v", err)
		}
		words := p.Words()
		if len(words) != PhraseWords {
			t.Fatalf("got %d words, want %d", len(words), PhraseWords)
		}
		back, err := ParsePhrase(p.String())
		if err != nil {
			t.Fatalf("ParsePhrase(%q): %v", p.String(), err)
		}
		if !bytes.Equal(back.Secret(), p.Secret()) {
			t.Fatalf("round trip changed the secret for %q", p.String())
		}
	}
}

// The phrase is meant to be written on paper and typed back by someone having a
// bad day. None of this is information, so none of it may change the answer.
func TestParseIsForgivingAboutEverythingButTheWords(t *testing.T) {
	p, err := NewPhrase()
	if err != nil {
		t.Fatalf("NewPhrase: %v", err)
	}
	w := p.Words()

	numbered := ""
	for i, x := range w {
		numbered += fmt.Sprintf("%d. %s\n", i+1, x)
	}
	clipped := make([]string, len(w))
	for i, x := range w {
		clipped[i] = prefixOf(x)
	}

	forms := map[string]string{
		"as printed":              strings.Join(w, " "),
		"shouting":                strings.ToUpper(strings.Join(w, " ")),
		"ragged spacing":          "  " + strings.Join(w, "   ") + "\t\n",
		"comma separated":         strings.Join(w, ", "),
		"off a printout":          strings.Join(w, "\n"),
		"numbered in a note":      numbered,
		"clipped to four letters": strings.Join(clipped, " "),
	}

	for name, form := range forms {
		got, err := ParsePhrase(form)
		if err != nil {
			t.Errorf("%s: ParsePhrase(%q): %v", name, form, err)
			continue
		}
		if !bytes.Equal(got.Secret(), p.Secret()) {
			t.Errorf("%s: parsed to a different secret", name)
		}
	}
}

func TestWrongLengthIsNamedAsSuch(t *testing.T) {
	p, _ := NewPhrase()
	short := strings.Join(p.Words()[:5], " ")
	_, err := ParsePhrase(short)
	var wrong *WrongLengthError
	if !errors.As(err, &wrong) {
		t.Fatalf("ParsePhrase(5 words) error = %v, want *WrongLengthError", err)
	}
	if wrong.Got != 5 {
		t.Errorf("WrongLengthError.Got = %d, want 5", wrong.Got)
	}
}

func TestUnknownWordIsNamedAndSuggested(t *testing.T) {
	p, _ := NewPhrase()
	w := p.Words()
	// "zzzzqq" is nothing like any word, so there is no honest suggestion.
	w[2] = "zzzzqq"
	_, err := ParsePhrase(strings.Join(w, " "))
	var unknown *UnknownWordError
	if !errors.As(err, &unknown) {
		t.Fatalf("error = %v, want *UnknownWordError", err)
	}
	if unknown.Position != 3 {
		t.Errorf("Position = %d, want 3 (1-based, as a person counts)", unknown.Position)
	}
	if unknown.Suggestion != "" {
		t.Errorf("Suggestion = %q, want none for gibberish", unknown.Suggestion)
	}
}

// A word that merely starts like a list word is not that word. Accepting
// "spirt" as "spirit" also accepts "spiral" as "spirit", and turns a typo we
// could have named into one only the checksum might notice.
func TestSharingAPrefixIsNotTheSameAsBeingClipped(t *testing.T) {
	p, _ := NewPhrase()
	w := p.Words()

	// Find a word long enough to mistype past its fourth letter.
	target, at := "", -1
	for i, x := range w {
		if len(x) >= 6 {
			target, at = x, i
			break
		}
	}
	if at == -1 {
		t.Skip("this phrase has no word long enough for the case")
	}

	// Same first four letters, different word: one letter of the tail changed.
	tail := []byte(target)
	if tail[4] == 'z' {
		tail[4] = 'a'
	} else {
		tail[4] = 'z'
	}
	w[at] = string(tail)

	_, err := ParsePhrase(strings.Join(w, " "))
	var unknown *UnknownWordError
	if !errors.As(err, &unknown) {
		t.Fatalf("ParsePhrase accepted %q in place of %q (err = %v)", tail, target, err)
	}
	if unknown.Position != at+1 {
		t.Errorf("Position = %d, want %d", unknown.Position, at+1)
	}
	if unknown.Suggestion != target {
		t.Errorf("Suggestion = %q, want %q", unknown.Suggestion, target)
	}
}

// The other half of the same rule: a token longer than the word it prefixes is
// not a clipping either.
func TestOvershootingAWordIsRefused(t *testing.T) {
	p, _ := NewPhrase()
	w := p.Words()
	w[0] = w[0] + "s"
	if _, err := ParsePhrase(strings.Join(w, " ")); err == nil {
		t.Errorf("ParsePhrase accepted %q, which is not a word and not a clipping", w[0])
	}
}

func TestNearestWordGuessesRealTypos(t *testing.T) {
	// Each of these is one edit away from exactly one list word.
	cases := map[string]string{
		"abandom": "abandon",
		"nurce":   "nurse",
		"zebrra":  "zebra",
	}
	for typo, want := range cases {
		if got := nearestWord(typo); got != want {
			t.Errorf("nearestWord(%q) = %q, want %q", typo, got, want)
		}
	}
}

// A guess that gets followed is worse than no guess, and these are the shapes
// where a guess would be a coin toss: "kitcen" is one edit from both "kitchen"
// and "kitten", and "fotress" is two from "actress", "fitness" and "forest"
// alike. Say nothing and let the person look at their paper again.
func TestNearestWordSaysNothingWhenItCannotTell(t *testing.T) {
	for _, ambiguous := range []string{"kitcen", "fotress"} {
		if got := nearestWord(ambiguous); got != "" {
			t.Errorf("nearestWord(%q) = %q, want no suggestion -- it is a tie", ambiguous, got)
		}
	}
}

func TestChecksumCatchesASwappedPair(t *testing.T) {
	// Every word real, order wrong. This is the residue the checksum exists
	// for -- nothing else in the parse can see it.
	caught := 0
	const tries = 200
	for i := 0; i < tries; i++ {
		p, _ := NewPhrase()
		w := p.Words()
		if w[0] == w[1] {
			continue
		}
		w[0], w[1] = w[1], w[0]
		if _, err := ParsePhrase(strings.Join(w, " ")); errors.Is(err, ErrPhraseChecksum) {
			caught++
		}
	}
	// One byte of checksum, so ~1 in 256 slips through. Anything near the
	// bottom of this range means the checksum is not wired up.
	if caught < tries-tries/20 {
		t.Errorf("checksum caught %d/%d swapped pairs, want nearly all", caught, tries)
	}
}

func TestPhrasesAreDistinct(t *testing.T) {
	seen := make(map[string]bool, 500)
	for i := 0; i < 500; i++ {
		p, err := NewPhrase()
		if err != nil {
			t.Fatalf("NewPhrase: %v", err)
		}
		s := p.String()
		if seen[s] {
			t.Fatalf("NewPhrase repeated %q -- the CSPRNG is not being read", s)
		}
		seen[s] = true
	}
}
