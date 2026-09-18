package supervisor

import (
	"bufio"
	"os"
	"strings"
	"testing"
)

// TestFilterAgainstARealConsoleLog replays a 901-line console capture from a
// real 13-minute Windows session through the filter.
//
// A unit test on invented lines proves the code does what it says; this proves
// the code does what is WANTED, which is a different question and the one that
// was being got wrong. The capture is the one attached to the report: "that
// stuff is just SO much information that clutters the actively useful things".
//
// Skipped when the capture is not present, so it never blocks a build.
func TestFilterAgainstARealConsoleLog(t *testing.T) {
	path := os.Getenv("GOBBONET_CONSOLE_CAPTURE")
	if path == "" {
		t.Skip("set GOBBONET_CONSOLE_CAPTURE to a console log to replay it")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Skipf("capture not readable: %v", err)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	var total, kept int
	var keptLines []string
	// The summary is replayed alongside the filter, because the two together are
	// what the user ends up hearing. Testing the filter alone would now score a
	// dropped line as clutter removed when it is really a fact moved.
	var sum loadSummary
	var sentences []string
	for sc.Scan() {
		line := sc.Text()
		i := strings.Index(line, "[llama] ")
		if i < 0 {
			continue
		}
		body := line[i+len("[llama] "):]
		total++
		sum.Feed(body)
		// A new server start means a new load, so the sentence for the previous
		// one is banked and the summary reset -- mirroring engineWatch.Reset.
		if strings.Contains(body, "server is listening") {
			sentences = append(sentences, sum.Line())
			sentences = append(sentences, sum.Notes()...)
			sum = loadSummary{}
		}
		if engineLineIsInteresting(body) {
			kept++
			keptLines = append(keptLines, body)
		}
	}
	if total == 0 {
		t.Skip("no [llama] lines in the capture")
	}

	pct := kept * 100 / total
	t.Logf("engine lines %d, kept %d (%d%%), hidden %d", total, kept, pct, total-kept)
	for _, l := range keptLines {
		t.Logf("  KEPT: %s", l)
	}
	for _, l := range sentences {
		t.Logf("  SAID: %s", l)
	}

	// The load dump and per-reply chatter are the bulk, so most of it must go.
	if pct > 25 {
		t.Errorf("kept %d%% of engine output; the point was to cut the clutter", pct)
	}

	// The facts have to survive SOMEWHERE -- relayed verbatim or said in the
	// summary. Asserted as facts rather than as lines, because which of the two
	// carries them is an implementation choice and this is the property that
	// actually matters: "did it reach the GPU" must be answerable from the
	// console.
	everything := strings.Join(append(append([]string{}, keptLines...), sentences...), "\n")
	for what, want := range map[string][]string{
		"whether the model reached the GPU": {"layers on the GPU", "offload"},
		"which device it ran on":            {"AMD Radeon RX 9070 XT"},
		"how much VRAM it took":             {"GB of VRAM", "MB of VRAM"},
	} {
		var found bool
		for _, w := range want {
			if strings.Contains(everything, w) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("the console no longer says %s (looked for any of %q)", what, want)
		}
	}

	// The nomic-embed load is in this capture, and its context mismatch is the
	// thing that went unexplained. It must now be explained.
	if !strings.Contains(everything, "trained for 2,048 tokens") {
		t.Error("the context mismatch that made the embedding model produce nonsense " +
			"is still not said in plain language")
	}

	// And the conversation must not be echoed to the console.
	for _, mustNot := range []string{"<|turn>"} {
		if strings.Contains(everything, mustNot) {
			t.Errorf("the formatted prompt reached the console (%q)", mustNot)
		}
	}
}
