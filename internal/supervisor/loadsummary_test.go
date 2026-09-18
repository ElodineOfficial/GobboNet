// The load sentence.
//
// Every input string in this file is one llama.cpp has actually printed, taken
// from a real Windows capture rather than written to suit the parser. That
// distinction is the whole value of the file: a parser tested against its own
// author's idea of the format passes and then meets a padded column.
package supervisor

import (
	"strings"
	"testing"
)

// A real Vulkan load, in the order the lines arrived.
var realVulkanLoad = []string{
	"0.00.082.472 I device_info:",
	"0.00.083.537 I   - Vulkan0 : AMD Radeon RX 9070 XT (16304 MiB, 15416 MiB free)",
	"0.00.083.544 I   - CPU     : AMD Ryzen 7 9700F 8-Core Processor              (32342 MiB, 20999 MiB free)",
	"0.00.910.981 I llama_prepare_model_devices: using device Vulkan0 (AMD Radeon RX 9070 XT) (unknown id) - 15416 MiB free",
	"0.01.776.206 I load_tensors: offloaded 43/43 layers to GPU",
	"0.01.776.211 I load_tensors:   CPU_Mapped model buffer size =  2730.00 MiB",
	"0.01.776.212 I load_tensors:      Vulkan0 model buffer size =  2934.68 MiB",
	"0.02.561.183 W llama_context: n_ctx_seq (32768) < n_ctx_train (131072) -- the full capacity of the model will not be utilized",
	"0.02.797.612 I srv  llama_server: model loaded",
}

func feed(lines []string) *loadSummary {
	var s loadSummary
	for _, l := range lines {
		s.Feed(l)
	}
	return &s
}

func TestTheLoadSentenceCarriesEveryFactWorthHaving(t *testing.T) {
	got := feed(realVulkanLoad).Line()

	for _, want := range []string{
		"AMD Radeon RX 9070 XT", // which device, by the name on the box
		"all 43 layers",         // how much of the model got there
		"GPU",
		"2.9 GB of VRAM", // and what it cost
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the sentence is missing %q.\ngot: %s", want, got)
		}
	}
	// The CPU-mapped buffer is not added to the VRAM figure. 2730 MiB of it is
	// on the host side, and reporting 5.5 GB of VRAM would be wrong by a factor
	// that matters on a 16 GB card.
	if strings.Contains(got, "5.5") {
		t.Errorf("the CPU buffer was counted as VRAM: %s", got)
	}
}

// A partial offload is the case people most want to see, because it is the one
// that explains why generation is slow.
func TestAPartialOffloadSaysSo(t *testing.T) {
	got := feed([]string{
		"0.00.083.537 I   - CUDA0 : NVIDIA GeForce RTX 3060 (12288 MiB, 11000 MiB free)",
		"0.01.776.206 I load_tensors: offloaded 20/43 layers to GPU",
		"0.01.776.212 I load_tensors:      CUDA0 model buffer size =  1400.00 MiB",
	}).Line()

	if !strings.Contains(got, "20 of 43 layers on the GPU") {
		t.Errorf("the split is not stated plainly.\ngot: %s", got)
	}
	if !strings.Contains(got, "the rest on the CPU") {
		t.Errorf("nothing says where the other layers went.\ngot: %s", got)
	}
}

// And no offload at all must never read as a successful GPU load, since that is
// the mistake that makes someone spend an evening on driver settings.
func TestACPUOnlyLoadNamesTheProcessor(t *testing.T) {
	got := feed([]string{
		"0.00.083.544 I   - CPU     : AMD Ryzen 7 9700F 8-Core Processor              (32342 MiB, 20999 MiB free)",
		"0.01.776.206 I load_tensors: offloaded 0/43 layers to GPU",
		"0.01.776.211 I load_tensors:   CPU_Mapped model buffer size =  2730.00 MiB",
	}).Line()

	if !strings.Contains(got, "AMD Ryzen 7 9700F") {
		t.Errorf("a CPU-only load did not name the CPU.\ngot: %s", got)
	}
	if !strings.Contains(got, "no GPU offload") {
		t.Errorf("a CPU-only load did not say the GPU was unused.\ngot: %s", got)
	}
	if !strings.Contains(got, "of RAM") {
		t.Errorf("the memory figure should be RAM, not VRAM.\ngot: %s", got)
	}
	if strings.Contains(got, "VRAM") {
		t.Errorf("a CPU-only load claimed VRAM.\ngot: %s", got)
	}
}

// The per-layer lines are folded in, so they must not also be relayed -- and
// if the total ever stops arriving, they have to carry the fact alone.
func TestThePerLayerOffloadLinesAreFoldedInWithAFallback(t *testing.T) {
	perLayer := []string{
		"0.01.776.199 I load_tensors: offloading output layer to GPU",
		"0.01.776.205 I load_tensors: offloading 41 repeating layers to GPU",
	}
	for _, l := range perLayer {
		if !summaryAbsorbs(l) {
			t.Errorf("not folded in, so the offload is announced twice:\n  %s", l)
		}
		if engineLineIsInteresting(l) {
			t.Errorf("relayed as well as folded in:\n  %s", l)
		}
	}

	// Without the "offloaded 43/43" total, the sentence must still say offload
	// happened rather than losing it along with the lines.
	got := feed(append(perLayer,
		"0.00.083.537 I   - Vulkan0 : AMD Radeon RX 9070 XT (16304 MiB, 15416 MiB free)")).Line()
	if !strings.Contains(got, "GPU") {
		t.Errorf("with the total missing, the offload vanished entirely.\ngot: %s", got)
	}
	if strings.Contains(got, " 0 ") || strings.Contains(got, "no GPU offload") {
		t.Errorf("a missing total was reported as zero layers.\ngot: %s", got)
	}

	// With the total, the exact count wins over the fallback wording.
	full := feed(append(perLayer, "0.01.776.206 I load_tensors: offloaded 43/43 layers to GPU")).Line()
	if !strings.Contains(full, "all 43 layers") {
		t.Errorf("the fallback overrode the real count.\ngot: %s", full)
	}
	if strings.Contains(full, "layers offloaded to the GPU") {
		t.Errorf("both the count and the fallback were said.\ngot: %s", full)
	}
}

// Nothing recognisable must produce nothing, not a sentence built from zeroes.
func TestAnUnrecognisableLoadSaysNothing(t *testing.T) {
	got := feed([]string{
		"0.00.000.001 I something_new: a format nobody has seen",
		"0.00.000.002 I another_thing: 42",
	}).Line()
	if got != "" {
		t.Errorf("invented a summary out of nothing: %q", got)
	}
}

// ---------------------------------------------------------------------------
// The notes. Both directions of the same mismatch.

func TestTheEmbeddingModelMismatchIsExplainedInPlainLanguage(t *testing.T) {
	// Verbatim from the session where nomic-embed was loaded as a chat model
	// and produced nonsense for eleven minutes.
	notes := feed([]string{
		"0.00.203.733 W llama_context: n_ctx_seq (32768) > n_ctx_train (2048) -- possible training context overflow",
	}).Notes()

	if len(notes) != 1 {
		t.Fatalf("got %d notes, want 1: %q", len(notes), notes)
	}
	for _, want := range []string{"2,048", "32,768", "embedding"} {
		if !strings.Contains(notes[0], want) {
			t.Errorf("the note does not mention %q.\ngot: %s", want, notes[0])
		}
	}
	// It must not use llama.cpp's terms, which are the reason the original line
	// told nobody anything.
	for _, jargon := range []string{"n_ctx_seq", "n_ctx_train"} {
		if strings.Contains(notes[0], jargon) {
			t.Errorf("the note still speaks llama.cpp: %s", notes[0])
		}
	}
}

// llama.cpp prints the same mismatch twice, in two different wordings, in one
// session. Missing either one means the note depends on which code path spoke.
func TestBothOfLlamaCppsWordingsForTheMismatchAreUnderstood(t *testing.T) {
	a := feed([]string{
		"0.00.203.733 W llama_context: n_ctx_seq (32768) > n_ctx_train (2048) -- possible training context overflow",
	}).Notes()
	b := feed([]string{
		"0.00.222.515 W srv    load_model: the slot context (32768) exceeds the training context of the model (2048) - capping",
	}).Notes()

	if len(a) != 1 || len(b) != 1 {
		t.Fatalf("one wording was not understood: first=%q second=%q", a, b)
	}
	if a[0] != b[0] {
		t.Errorf("the two wordings produced different notes:\n  %s\n  %s", a[0], b[0])
	}
}

func TestAnUnderusedContextIsTurnedIntoAdvice(t *testing.T) {
	notes := feed([]string{
		"0.02.561.183 W llama_context: n_ctx_seq (32768) < n_ctx_train (131072) -- the full capacity of the model will not be utilized",
	}).Notes()

	if len(notes) != 1 {
		t.Fatalf("got %d notes, want 1: %q", len(notes), notes)
	}
	if !strings.Contains(notes[0], "CONFIG") {
		t.Errorf("the note does not say where to change it.\ngot: %s", notes[0])
	}
	if !strings.Contains(notes[0], "VRAM") {
		t.Errorf("the note does not mention the cost of changing it.\ngot: %s", notes[0])
	}
}

// A small difference is not worth a line on every single load.
func TestASmallContextDifferenceIsNotWorthSaying(t *testing.T) {
	for _, line := range []string{
		"W llama_context: n_ctx_seq (32768) < n_ctx_train (40960) -- ...",
		"W llama_context: n_ctx_seq (8192) > n_ctx_train (8192) -- ...",
		"W llama_context: n_ctx_seq (4096) < n_ctx_train (8192) -- ...",
	} {
		if notes := feed([]string{line}).Notes(); len(notes) != 0 {
			t.Errorf("%q produced a note nobody needs: %q", line, notes)
		}
	}
}

// ---------------------------------------------------------------------------
// The property the filter depends on.

// summaryAbsorbs must say yes for exactly the lines the sentence covers, so a
// line can be hidden from the console without the fact disappearing with it.
func TestTheFilterOnlyHidesLinesTheSummaryActuallyRead(t *testing.T) {
	for _, l := range realVulkanLoad {
		absorbed := summaryAbsorbs(l)
		onScreen := engineLineIsInteresting(l)
		if absorbed && onScreen {
			t.Errorf("both summarised AND relayed, so it is said twice:\n  %s", l)
		}
	}
}

// The fail-open direction, which is the reason summaryAbsorbs asks the parser
// instead of consulting a list. A reworded line must reach the screen rather
// than vanish from both places.
func TestARewordedLineIsNotSilentlyDropped(t *testing.T) {
	// llama.cpp renaming its offload line, which it has done before.
	reworded := "0.01.776.206 I load_tensors: moved 43 of 43 blocks onto the accelerator"
	if summaryAbsorbs(reworded) {
		t.Fatal("the parser claims to understand a line it cannot read")
	}
	// It must therefore still be shown, so somebody notices.
	if !engineLineIsInteresting(reworded) {
		t.Error("a line the summary cannot read was ALSO hidden from the console -- " +
			"the fact is now in neither place, which is the failure this design exists to prevent")
	}
}

// A swap must not inherit the previous model's numbers.
func TestResetClearsTheSummary(t *testing.T) {
	w := newEngineWatch()
	for _, l := range realVulkanLoad {
		w.Write([]byte(l + "\n"))
	}
	if w.LoadLine() == "" {
		t.Fatal("setup failed: nothing was harvested")
	}
	w.Reset()
	if got := w.LoadLine(); got != "" {
		t.Errorf("Reset left a summary behind, so the next swap would report the previous model: %s", got)
	}
	if len(w.LoadNotes()) != 0 {
		t.Error("Reset left notes behind")
	}
}

// The harvest runs on a byte stream, so a line arriving in pieces must still be
// read. This is the same failure mode as the GPU marker scan and it is easy to
// get wrong twice.
func TestTheHarvestSurvivesLinesSplitAcrossWrites(t *testing.T) {
	w := newEngineWatch()
	w.Write([]byte("0.01.776.206 I load_tensors: offloa"))
	w.Write([]byte("ded 43/43 layers to GPU\n0.01.776.212 I load_tensors:      Vulkan0 mod"))
	w.Write([]byte("el buffer size =  2934.68 MiB\n"))

	got := w.LoadLine()
	if !strings.Contains(got, "all 43 layers") {
		t.Errorf("a split offload line was missed.\ngot: %s", got)
	}
	if !strings.Contains(got, "2.9 GB") {
		t.Errorf("a split buffer-size line was missed.\ngot: %s", got)
	}
}

// ---------------------------------------------------------------------------
// The small parsers, where an off-by-one produces a confidently wrong number.

func TestNumbersAreReadOutOfPaddedColumns(t *testing.T) {
	if got := parseMiB("load_tensors:      Vulkan0 model buffer size =  2934.68 MiB"); got != 2934.68 {
		t.Errorf("parseMiB = %v, want 2934.68", got)
	}
	// GiB normalised to MiB, or a 4 GiB buffer would report as 4 MB.
	if got := parseMiB("some buffer size = 4.00 GiB"); got != 4096 {
		t.Errorf("parseMiB(GiB) = %v, want 4096", got)
	}
	if got := parseMiB("no units here at all"); got != 0 {
		t.Errorf("parseMiB on a unitless line = %v, want 0", got)
	}
}

func TestLayerFractionsParse(t *testing.T) {
	for _, tc := range []struct {
		in   string
		a, b int
		ok   bool
	}{
		{"43/43 layers to GPU", 43, 43, true},
		{"0/43 layers to GPU", 0, 43, true},
		{"43 layers to GPU", 0, 0, false},
		{"x/y layers", 0, 0, false},
		{"43/0 layers", 0, 0, false}, // a zero denominator is not a fact
	} {
		a, b, ok := parseFraction(tc.in)
		if a != tc.a || b != tc.b || ok != tc.ok {
			t.Errorf("parseFraction(%q) = %d,%d,%v; want %d,%d,%v", tc.in, a, b, ok, tc.a, tc.b, tc.ok)
		}
	}
}

// Read aloud, "32768" is often five digits one at a time; "32,768" is a number.
func TestBigNumbersAreGroupedForReadingAloud(t *testing.T) {
	for in, want := range map[int]string{
		0: "0", 512: "512", 2048: "2,048", 32768: "32,768", 131072: "131,072", 1048576: "1,048,576",
	} {
		if got := commas(in); got != want {
			t.Errorf("commas(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestMemoryIsRenderedInTheUnitPeopleRead(t *testing.T) {
	for in, want := range map[float64]string{
		114.90:  "115 MB", // an embedding model; "0.1 GB" is useless
		1023:    "1023 MB",
		2934.68: "2.9 GB",
		16304:   "15.9 GB",
	} {
		if got := gigabytes(in); got != want {
			t.Errorf("gigabytes(%v) = %q, want %q", in, got, want)
		}
	}
}
