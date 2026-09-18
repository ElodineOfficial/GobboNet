package supervisor

import (
	"fmt"
	"strconv"
	"strings"
)

/*
A model load, said in one sentence.

WHY SUMMARISE RATHER THAN FILTER

Filtering llama.cpp's load output got a 200-line dump down to seventeen lines.
Seventeen is better than two hundred and still wrong, because of what the lines
are:

	0.00.083.537 I   - Vulkan0 : AMD Radeon RX 9070 XT (16304 MiB, 15416 MiB free)
	0.01.776.206 I load_tensors: offloaded 43/43 layers to GPU
	0.01.776.212 I load_tensors:      Vulkan0 model buffer size =  2934.68 MiB
	0.02.797.612 I srv  llama_server: model loaded

Those are four lines carrying three facts, in padded columns, with the facts in
different places on each line. Read down a screen they are fine. Read ALOUD,
one line at a time, with no way to skim back -- which is how this console is
actually read -- they are four sentences that each stop halfway through an
answer. And the primary user of this console is blind.

So the load-time lines are harvested here and the console gets the sentence
instead:

	[swap] loaded in 2.8s on AMD Radeon RX 9070 XT -- all 43 layers on the GPU, 2.9 GB of VRAM

One line, verb near the front, every number in the place a sentence puts it. The
padded originals still go to the log file, every time, and
`engine_output_full = true` puts them back on screen for anyone debugging.

WHAT IS NOT SUMMARISED. Warnings and errors. They pass through untouched, in
llama.cpp's own words. A summary is a convenience for the routine case; the
non-routine case is exactly where somebody's own wording beats a paraphrase of
it, and this project has already been bitten once by output that went quiet.
*/

// loadSummary accumulates what one model load said about itself.
//
// Fed every line, keeps the few that answer a question. Nothing here parses
// strictly: a field that does not turn up is simply absent from the sentence,
// because llama.cpp rewords its own log strings and a summary that breaks when
// it does would be worse than no summary.
type loadSummary struct {
	device   string // "AMD Radeon RX 9070 XT"
	backend  string // "Vulkan0", "CUDA0", ...
	cpuName  string // "AMD Ryzen 7 9700F 8-Core Processor"
	onGPU    int    // layers offloaded
	ofLayers int    // ...out of this many
	sawSplit bool   // an "offloaded N/M" line was seen at all
	// sawOffloading records the per-layer lines that precede it. Only used when
	// the N/M total never arrives, so the sentence can still say offload
	// happened rather than losing it with the line.
	sawOffloading bool
	gpuMiB        float64
	cpuMiB        float64
	ctxSeq        int
	ctxTrain      int
}

// Feed takes one line of engine output.
func (s *loadSummary) Feed(line string) {
	body := stripEngineStamp(strings.TrimSpace(line))
	flat := strings.Join(strings.Fields(body), " ")

	switch {
	// "- Vulkan0 : AMD Radeon RX 9070 XT (16304 MiB, 15416 MiB free)"
	case strings.HasPrefix(flat, "- ") && strings.Contains(flat, " : "):
		name, rest, _ := strings.Cut(strings.TrimPrefix(flat, "- "), " : ")
		name = strings.TrimSpace(name)
		what := strings.TrimSpace(firstBefore(rest, "("))
		switch {
		case name == "":
			return
		case name == "CPU":
			// Kept so a CPU-only load can name the processor instead of saying
			// "on the CPU", which is the one case where this line is the only
			// place the answer appears.
			s.cpuName = what
		case s.device == "":
			// First device wins. llama.cpp lists them in its own preference
			// order and the chosen one is confirmed later by "using device".
			s.backend = name
			s.device = what
		}

	// "llama_prepare_model_devices: using device Vulkan0 (AMD Radeon RX 9070 XT) ..."
	case strings.Contains(flat, "using device "):
		after := flat[strings.Index(flat, "using device ")+len("using device "):]
		be, rest, found := strings.Cut(after, " ")
		s.backend = strings.TrimSpace(be)
		if found {
			if open := strings.Index(rest, "("); open >= 0 {
				if close := strings.Index(rest[open:], ")"); close > 0 {
					s.device = strings.TrimSpace(rest[open+1 : open+close])
				}
			}
		}

	// "load_tensors: offloaded 43/43 layers to GPU"
	case strings.Contains(flat, "offloaded ") && strings.Contains(flat, "layers"):
		if a, b, ok := parseFraction(afterWord(flat, "offloaded ")); ok {
			s.onGPU, s.ofLayers, s.sawSplit = a, b, true
		}

	// The per-layer lines that come BEFORE that summary:
	//
	//	load_tensors: offloading 41 repeating layers to GPU
	//	load_tensors: offloading output layer to GPU
	//
	// The same fact in instalments, so they are taken here rather than relayed
	// -- otherwise one load announces its offload three times, twice in
	// llama.cpp's words and once in ours.
	//
	// Recorded as a flag and not a count on purpose: adding "41 repeating" to
	// "output" to reach 42 is arithmetic on wording that could change, and the
	// line that states the total plainly is right underneath. The flag is the
	// fallback for a day when it is not.
	case strings.Contains(flat, "offloading ") && strings.Contains(flat, "GPU"):
		s.sawOffloading = true

	// "load_tensors:  Vulkan0 model buffer size =  2934.68 MiB"
	// "load_tensors:  CPU_Mapped model buffer size =  2730.00 MiB"
	case strings.Contains(flat, "model buffer size"):
		who := strings.TrimSpace(firstBefore(flat, "model buffer size"))
		if i := strings.LastIndex(who, ":"); i >= 0 {
			who = strings.TrimSpace(who[i+1:])
		}
		mib := parseMiB(flat)
		if mib <= 0 {
			return
		}
		// Summed rather than replaced: a model split across devices reports one
		// line per buffer, and the total is the number the user cares about.
		if strings.HasPrefix(who, "CPU") {
			s.cpuMiB += mib
		} else {
			s.gpuMiB += mib
		}

	// "llama_context: n_ctx_seq (32768) > n_ctx_train (2048) -- possible training
	// context overflow"
	case strings.Contains(flat, "n_ctx_seq") && strings.Contains(flat, "n_ctx_train"):
		s.ctxSeq = parseParen(flat, "n_ctx_seq")
		s.ctxTrain = parseParen(flat, "n_ctx_train")

	// llama.cpp's second wording for the same mismatch, from a different part of
	// the server: "srv load_model: the slot context (32768) exceeds the training
	// context of the model (2048) - capping". Both turn up in one session, which
	// is the reason for matching on wording rather than on a function prefix.
	case strings.Contains(flat, "slot context") && strings.Contains(flat, "training context"):
		s.ctxSeq = parseParen(flat, "slot context")
		s.ctxTrain = parseParen(flat, "training context of the model")
	}
}

// Line returns the one-sentence summary, or "" if nothing useful was seen.
//
// Empty is a real answer: a load that printed nothing recognisable should
// produce no sentence at all rather than a confident-sounding line assembled
// out of defaults.
func (s *loadSummary) Line() string {
	var where string
	switch {
	case s.sawSplit && s.onGPU == 0 && s.cpuName != "":
		where = "on " + s.cpuName
	case s.sawSplit && s.onGPU == 0:
		where = "on the CPU"
	case s.device != "":
		where = "on " + s.device
	case s.backend != "":
		where = "on " + s.backend
	case s.sawSplit || s.sawOffloading:
		where = "on the GPU"
	default:
		return ""
	}

	parts := []string{}
	if s.sawSplit {
		switch {
		case s.onGPU == 0:
			parts = append(parts, fmt.Sprintf("no GPU offload (all %d layers on the CPU)", s.ofLayers))
		case s.onGPU >= s.ofLayers:
			parts = append(parts, fmt.Sprintf("all %d layers on the GPU", s.ofLayers))
		default:
			parts = append(parts, fmt.Sprintf("%d of %d layers on the GPU, the rest on the CPU",
				s.onGPU, s.ofLayers))
		}
	}
	if !s.sawSplit && s.sawOffloading {
		// No total arrived, but the per-layer lines did. Say the part that is
		// known rather than nothing.
		parts = append(parts, "layers offloaded to the GPU")
	}
	if s.gpuMiB > 0 {
		parts = append(parts, gigabytes(s.gpuMiB)+" of VRAM")
	}
	if s.gpuMiB == 0 && s.cpuMiB > 0 {
		parts = append(parts, gigabytes(s.cpuMiB)+" of RAM")
	}

	if len(parts) == 0 {
		return where
	}
	return where + " -- " + strings.Join(parts, ", ")
}

// Notes returns plain-language warnings worth saying in GobboNet's own voice
// rather than llama.cpp's.
//
// Both entries are about the same pair of numbers, and they are here because
// llama.cpp's version of this is the line that would have answered "something
// is up with the nomadic model" and did not:
//
//	n_ctx_seq (32768) > n_ctx_train (2048) -- possible training context overflow
//
// True, marked as a warning, and it tells a non-specialist nothing. A model
// trained for 2,048 tokens being run at 32,768 is not a tuning choice that went
// slightly wrong; it means the file is not a chat model at all, which is exactly
// what nomic-embed-text is.
//
// The other direction is worth saying too, and llama.cpp's wording for it --
// "the full capacity of the model will not be utilized" -- is a fact with no
// action attached. Said properly it is one of the few genuinely useful knobs a
// user has.
//
// Both are reported only when the gap is large, because llama.cpp emits this
// pair on every single load and a note on every load is the clutter this is
// meant to remove.
func (s *loadSummary) Notes() []string {
	if s.ctxTrain <= 0 || s.ctxSeq <= 0 {
		return nil
	}
	var out []string
	switch {
	case s.ctxSeq > s.ctxTrain*2:
		out = append(out, fmt.Sprintf(
			"this model was trained for %s tokens of context but is set to %s. "+
				"Replies past its training length may come out garbled; if it is an "+
				"embedding or reranking model it is not meant for chat at all",
			commas(s.ctxTrain), commas(s.ctxSeq)))
	case s.ctxSeq*2 < s.ctxTrain:
		out = append(out, fmt.Sprintf(
			"using %s of the %s tokens of context this model supports -- raise "+
				"the context setting in CONFIG if you want it to remember more, "+
				"at the cost of VRAM",
			commas(s.ctxSeq), commas(s.ctxTrain)))
	}
	return out
}

// ---------------------------------------------------------------------------
// Small parsers. Each one returns a zero value rather than an error: a number
// that did not parse means that clause is left out of the sentence.

func firstBefore(s, sep string) string {
	if i := strings.Index(s, sep); i >= 0 {
		return s[:i]
	}
	return s
}

func afterWord(s, word string) string {
	if i := strings.Index(s, word); i >= 0 {
		return s[i+len(word):]
	}
	return ""
}

// parseFraction reads the "43/43" at the front of a string.
func parseFraction(s string) (int, int, bool) {
	f := strings.Fields(s)
	if len(f) == 0 {
		return 0, 0, false
	}
	a, b, ok := strings.Cut(f[0], "/")
	if !ok {
		return 0, 0, false
	}
	ai, err1 := strconv.Atoi(strings.TrimSpace(a))
	bi, err2 := strconv.Atoi(strings.TrimSpace(b))
	if err1 != nil || err2 != nil || bi <= 0 {
		return 0, 0, false
	}
	return ai, bi, true
}

// parseMiB reads the number before a "MiB" or "GiB" unit and returns MiB.
func parseMiB(s string) float64 {
	f := strings.Fields(s)
	for i, tok := range f {
		unit := strings.TrimSuffix(tok, ",")
		if unit != "MiB" && unit != "GiB" {
			continue
		}
		if i == 0 {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSuffix(f[i-1], ","), 64)
		if err != nil {
			continue
		}
		if unit == "GiB" {
			v *= 1024
		}
		return v
	}
	return 0
}

// parseParen reads the integer in "name (1234)".
func parseParen(s, name string) int {
	rest := afterWord(s, name)
	open := strings.Index(rest, "(")
	if open < 0 {
		return 0
	}
	close := strings.Index(rest[open:], ")")
	if close < 0 {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(rest[open+1 : open+close]))
	if err != nil {
		return 0
	}
	return n
}

// gigabytes renders MiB as the GB figure people are used to seeing in task
// managers and nvidia-smi. Binary division, decimal label, which is the
// convention those tools use and the one the user will be comparing against.
func gigabytes(mib float64) string {
	// Under a gigabyte, say megabytes. "0.1 GB" for a 115 MB embedding model is
	// technically right and useless; two significant figures is the point of
	// saying the number at all.
	if mib < 1024 {
		return fmt.Sprintf("%.0f MB", mib)
	}
	return fmt.Sprintf("%.1f GB", mib/1024)
}

// commas groups an integer for reading aloud: "32,768" is four tokens a screen
// reader says as a number, "32768" is often five digits said one at a time.
func commas(n int) string {
	s := strconv.Itoa(n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	lead := len(s) % 3
	if lead > 0 {
		b.WriteString(s[:lead])
	}
	for i := lead; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}
