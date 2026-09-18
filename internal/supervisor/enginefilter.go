package supervisor

import "strings"

/*
Which of llama.cpp's lines are worth a person's attention.

WHY FILTER AT ALL

Putting the engine's output on screen fixed a window that looked frozen. It
also buried the things anyone actually watches for. In a real 13-minute session
the console was 901 lines, and 680 of them -- 75% -- were the engine:

	182  print_info:                 model metadata, during load
	139  llama_model_loader:         GGUF key/value pairs, during load
	 42  llama_context:
	 30  sched_reserve:
	 29  load:
	 18  load_tensors:
	  9  slot print_timing:          per reply
	  9  slot launch_slot_:          per reply
	  8  srv update_slots:           per reply ("all slots are idle")
	  5  the formatted prompt itself, echoed back

The events people are looking for -- model loaded, a hot swap, the server
standing down -- were single lines adrift in that. So the load dump and the
per-reply chatter are held back, and everything else goes through.

TWO RULES, AND THE SECOND ONE MATTERS MORE

  1. A known-noisy prefix is dropped.
  2. ANYTHING ELSE IS KEPT.

Rule 2 is the important one. llama.cpp's log strings are internal wording, not
an interface it owes anyone, and it has reworded them before -- issue #33 was
exactly that. A filter built as an allow-list would silently start hiding new
messages the day upstream renames something, and nobody would notice, which is
the failure this whole area has already had once. Dropping a short list of
things we have SEEN to be noise, and passing the rest, fails in the harmless
direction: a bit of clutter rather than silence.

Warnings and errors are never dropped, whatever their prefix.

The log file is unaffected. It always receives everything.
*/

// noisyPrefixes are the message prefixes held back from the console. Each one
// was counted in a real session before being listed; none is a guess.
var noisyPrefixes = []string{
	// The load dump. Hundreds of lines describing a model the user chose on
	// purpose and can see named on the line above.
	"print_info:",
	"llama_model_loader:",
	"llama_context:",
	"llama_kv_cache:",
	"llama_kv_cache_iswa:",
	"llama_kv_cache_unified:",
	"sched_reserve:",
	"load:",
	"common_init_result:",
	"common_params_fit_impl:",
	"common_fit_params:",
	"common_memory_breakdown_print:",
	"init_tokenizer:",
	"print_timing:",
	"load_tensors:",
	// The engine build, repeated on every single start. It belongs in a bug
	// report, not read aloud on every swap -- and it is in the log file every
	// time, in ENGINE.txt, and in `gobbonet engine status`.
	"common_params_print_info:",
	// A bare column header with its entries folded into the load summary, so
	// on its own it announces nothing.
	"device_info:",

	// Per-reply bookkeeping. One set per message, and "all slots are idle" in
	// particular reads like an idle-timeout event when it is nothing of the
	// kind -- it means the engine has finished a request.
	"slot launch_slot_:",
	"slot update_slots:",
	"slot release:",
	"slot print_timing:",
	"update_slots:",
	"get_availabl",
	"params_from_:",
	"init_sampler:",
	"create_check:",
	"log_server_r:",
	"slot release:",
	"srv update:",
}

// loadLinesWorthKeeping are load-time lines that survive the cull.
//
// It used to be ten times this long, and the list shrank twice for different
// reasons. First, replaying a real session showed a looser version keeping 136
// lines of 680 -- six separate buffer-size reports and the chat template's
// worked example among them. Then the load summary arrived (loadsummary.go) and
// took over the lines that carried FACTS: the device list, "using device",
// "offloaded 43/43", the buffer sizes, "model loaded". Those are now read off
// the stream and said once, as a sentence, so relaying them as well would be
// saying the same thing twice in a worse format.
//
// What is left is the lines that are neither facts for the summary nor noise:
// something happening that the user is waiting through, and the backends
// announcing themselves.
var loadLinesWorthKeeping = []string{
	"warming up the model", // explains a pause with no other explanation
	"ggml_vulkan:", "ggml_cuda", "ggml_metal", "ggml_sycl",
}

// summaryAbsorbs reports whether loadSummary took a fact out of this line.
//
// This is how the load-time lines are dropped without risking silence, and the
// mechanism is the point. A hard-coded list of "lines the summary covers" would
// go stale the day llama.cpp rewords one: the list would still match the old
// wording, the line would still be dropped, and the summary would no longer be
// getting the fact -- so it would vanish from BOTH places. That is the exact
// failure this whole area has already had once.
//
// Asking the parser instead makes the two impossible to disagree. A line is
// hidden only if feeding it to a throwaway summary changed something, which
// means the fact is now in the sentence. A line the parser no longer
// understands changes nothing, so it is not hidden, so it appears on screen
// looking slightly out of place -- which is how anyone would find out.
func summaryAbsorbs(line string) bool {
	var probe loadSummary
	probe.Feed(line)
	return probe != loadSummary{}
}

// alwaysNoise are substrings that mean "drop this", whatever else the line
// contains -- checked before the keepers, because some of them would otherwise
// match one.
var alwaysNoise = []string{
	// The chat template's worked example. It is several lines of turn markers
	// and sample text, it is the template rather than anything happening, and
	// it is the shape that at -lv 4 also echoes the real conversation.
	"example_format",
	"chat template",
	// Advice and links, once per load.
	"prompt cache is enabled",
	"--cache-ram 0",
	"for more info see",
	"use `--",
	// The CPU feature-flag wall: one line, 300 characters.
	"system_info:",
	// Per-load server plumbing nobody asked about.
	"running without SSL",
	"threads for HTTP server",
	"binding port",
	"initializing slots",
	"new slot,",
	"speculative decoding",
	"verbosity =",
	"common_memory_breakdown_print",
	"cache state:",
	// llama.cpp reconciling two of its OWN defaults. Marked W, which is why it
	// has to be named here rather than left to the severity rule, and checked
	// against BuildArgs first: GobboNet passes neither flag, so there is
	// nothing here for a user to act on.
	"--cache-idle-slots requires",
	// "srv  llama_server: loading model" and "srv  load_model: loading model
	// 'C:\...\thing.gguf'". Both say what "[swap] LOADING thing.gguf" said a
	// moment earlier, one of them with 70 characters of absolute path.
	"llama_server: loading model",
	"load_model: loading model",
	// "model loaded" and "server is listening on http://127.0.0.1:11437". The
	// first is what the load summary line already announces. The second names
	// the INTERNAL llama.cpp port, which is not the address the user opens and
	// never should be -- putting it on screen invites them to try it.
	"llama_server: model loaded",
	"server is listening",
}

// severe matches llama.cpp's own severity markers and the words it uses when
// something has gone wrong. Never filtered.
func severe(line string) bool {
	low := strings.ToLower(line)
	for _, w := range []string{"error", "failed", "cannot", "warning", "warn:", "out of memory", "unsupported"} {
		if strings.Contains(low, w) {
			return true
		}
	}
	// The single-letter severity column in llama.cpp's timestamped format:
	// "0.02.789.785 W srv init: ..." -- W and E, but not I or D.
	f := strings.Fields(line)
	for i, tok := range f {
		if i > 2 {
			break
		}
		if tok == "W" || tok == "E" {
			return true
		}
	}
	return false
}

// engineLineIsInteresting decides whether one line of engine output reaches the
// console. Errors first, then the keepers, then the noise list, then keep.
func engineLineIsInteresting(line string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return false
	}
	// Turn markers mean the line carries conversation, not diagnostics. At
	// -lv 4 llama.cpp echoes the formatted prompt, so this is both the bulkiest
	// noise and the one part of the engine's output that is nobody else's
	// business on a screen someone might be sharing.
	if strings.Contains(trimmed, "<|") || strings.Contains(trimmed, "<s>") {
		return false
	}
	for _, n := range alwaysNoise {
		if strings.Contains(trimmed, n) {
			return false
		}
	}
	// Before the severity check, and that ordering is deliberate. Some of the
	// facts the summary carries arrive on lines llama.cpp marks W -- the
	// context-length mismatch in particular -- and the summary's version of
	// that says strictly more in plainer words. Keeping both would mean hearing
	// the same fact twice, once uselessly.
	//
	// It is safe to put a W line behind this only because summaryAbsorbs is
	// answered by the parser rather than by a list: if it says yes, the fact is
	// in the sentence.
	if summaryAbsorbs(trimmed) {
		return false
	}
	if severe(trimmed) {
		return true
	}
	for _, k := range loadLinesWorthKeeping {
		if strings.Contains(trimmed, k) {
			return true
		}
	}

	// Strip llama.cpp's "0.02.789.785 I " timestamp+severity so the prefix
	// match below sees the message itself.
	body := stripEngineStamp(trimmed)

	// The prompt echo. At -lv 4 llama.cpp prints the formatted prompt, which is
	// the conversation -- so this is both the bulkiest noise and the one bit of
	// engine output that is nobody else's business on a shared screen. It is
	// recognised by NOT looking like a diagnostic: diagnostics are
	// "something: detail", and a chat turn is not.
	if !looksLikeDiagnostic(body) {
		return false
	}

	// Collapse runs of spaces before matching. llama.cpp pads the function-name
	// column to line its output up, so the same message arrives as
	// "slot release:" on one line and "slot      release:" on the next. A
	// prefix list that does not account for that silently misses half of what
	// it names -- which it did: the per-reply lines went on appearing while the
	// list claimed to drop them.
	flat := strings.Join(strings.Fields(body), " ")

	// The prefix rule is not allowed to drop a line about offloading, and this
	// exemption was added because a test proved the fail-open claim above was
	// FALSE without it.
	//
	// "offloaded 43/43 layers to GPU" is the single most-watched line in the
	// whole stream, and its prefix is `load_tensors:` -- which is on the noisy
	// list, because the other eighteen load_tensors lines are buffer arithmetic.
	// So it survived only by being recognised first: once by the old keep-list,
	// now by the summary. Reword it upstream and neither recognises it, the
	// prefix rule drops it, and the answer to "is my GPU being used" disappears
	// from the console without anybody touching this file.
	//
	// So: a line that mentions offloading and was not understood well enough to
	// be summarised goes on screen, prefix or no prefix. It will look out of
	// place. That is the intended outcome -- out of place is how someone notices.
	for _, w := range watchedWords {
		if strings.Contains(strings.ToLower(flat), w) {
			return true
		}
	}

	for _, p := range noisyPrefixes {
		if strings.HasPrefix(flat, p) || strings.Contains(flat, " "+p) {
			return false
		}
	}
	return true
}

// watchedWords are the vocabulary of the one question the console exists to
// answer. Lowercase; matched case-insensitively.
//
// Kept deliberately short. Every addition risks readmitting part of the load
// dump, so each was checked against the real capture: with these three, the
// replay keeps 9 engine lines out of 680. "layers" alone would have readmitted
// nothing measurable either, but it is the sort of word that turns up in
// metadata dumps, so the narrower forms are used.
var watchedWords = []string{
	"offload",   // "offloaded", "offloading"
	"accelerat", // "accelerator", "acceleration"
	"layers to gpu",
}

// stripEngineStamp removes a leading "0.02.789.785 I " style stamp.
func stripEngineStamp(line string) string {
	f := strings.Fields(line)
	if len(f) < 2 {
		return line
	}
	// A stamp is digits and dots, followed by a single severity letter.
	if strings.Trim(f[0], "0123456789.") == "" && len(f[1]) == 1 {
		rest := strings.TrimSpace(strings.TrimPrefix(line, f[0]))
		return strings.TrimSpace(strings.TrimPrefix(rest, f[1]))
	}
	return line
}

// looksLikeDiagnostic reports whether a line has the "label: value" shape
// llama.cpp uses for everything it says about itself.
//
// Deliberately loose. The question being asked is "is this the engine talking
// about itself, or is it echoing my conversation back at me", and a colon in
// the first few words answers it well enough without trying to parse chat
// formats that change with every model.
func looksLikeDiagnostic(body string) bool {
	if i := strings.Index(body, ":"); i > 0 && i < 48 {
		return !strings.ContainsAny(body[:i], "<|>")
	}
	return false
}

// EngineLineIsInterestingForTest exposes the filter for the harness that
// replays a real console log through it.
func EngineLineIsInterestingForTest(line string) bool { return engineLineIsInteresting(line) }
