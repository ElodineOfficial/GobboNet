package supervisor

import (
	"bytes"
	"io"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

/*
The engine's output, on screen.

WHY THIS EXISTS

llama-server's stdout went to a log file and its stderr to a log file plus a
64 KB in-memory ring, and neither of those is a terminal. So from the moment
gobbonet became the program people actually run, nothing llama.cpp printed
reached anybody's eyes. The console showed:

	[..] starting llama-server from ...\llama-server.exe
	                                            <- nothing, for up to a minute
	[OK] model loaded: gemma-4-e4b-it-Q4_K_M.gguf

launch.bat gave llama-server its own titled window (`start /min "llama-server"`)
and it also confirmed GPU offload on screen afterwards. Moving to one window was
deliberate and worth keeping -- one process, carrying the app's own icon. Losing
the output was not deliberate at all, and it took a bug report to notice, which
is exactly what invisible output does.

So the streams are tee'd here as well, and scanned on the way past for the two
facts a user actually needs out of them: did the model reach the GPU, and is it
tight on VRAM.
*/

// prefixWriter writes whole lines to an underlying writer, each with a prefix.
//
// Whole lines, because the reader has two programs' output in one window and
// needs to tell them apart. A prefix stamped on every Write() instead would
// land mid-sentence -- llama.cpp writes progress in fragments, and the result
// would be the one thing worse than no output, which is output nobody trusts.
type prefixWriter struct {
	mu     sync.Mutex
	out    io.Writer
	prefix string
	buf    bytes.Buffer
	// filter drops the load dump and the per-reply chatter. See
	// enginefilter.go for what that means and why the rule fails open.
	filter bool
}

func newPrefixWriter(out io.Writer, prefix string, filter bool) *prefixWriter {
	return &prefixWriter{out: out, prefix: prefix, filter: filter}
}

func (w *prefixWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Never report a short write to exec: a partial line held back here is
	// buffered, not dropped, and returning less than len(p) makes io.Copy
	// treat it as an error.
	w.buf.Write(p)
	for {
		line, err := w.buf.ReadString('\n')
		if err != nil {
			// No newline yet. Put the fragment back and wait for the rest.
			w.buf.Reset()
			w.buf.WriteString(line)
			break
		}
		line = strings.TrimRight(line, "\r\n")
		// A blank line from the engine is still a line the user saw in 1.7.3,
		// but an empty prefixed line is noise, so it collapses to nothing.
		if strings.TrimSpace(line) == "" {
			continue
		}
		if w.filter && !engineLineIsInteresting(line) {
			continue
		}
		if _, err := io.WriteString(w.out, w.prefix+line+"\n"); err != nil {
			return len(p), nil
		}
	}
	return len(p), nil
}

// Flush emits whatever is left without a trailing newline. Called when the
// process exits, so the last line of a crash is not swallowed.
func (w *prefixWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	rest := strings.TrimRight(w.buf.String(), "\r\n")
	w.buf.Reset()
	// A final fragment is nearly always the reason a process died, so it is
	// shown even when filtering: the filter exists to hide routine bulk, not
	// last words.
	if strings.TrimSpace(rest) != "" {
		_, _ = io.WriteString(w.out, w.prefix+rest+"\n")
	}
}

// Offload wording llama.cpp uses when layers reach the GPU.
//
// Several patterns rather than one, and the list is launch.bat's, carried over
// verbatim in spirit: these are llama.cpp's internal log strings, not an
// interface it owes anyone, and it has already moved them once (issue #33).
// "offloading" catches the per-layer lines that precede the "offloaded N/N"
// summary; the backend names cover an engine someone swapped in by hand. Any
// single hit is enough.
var offloadMarkers = []string{
	"offloaded", "offloading",
	"Vulkan0", "CUDA0", "Metal0", "ROCm0", "SYCL0",
}

// What llama.cpp says when the model barely fits, or does not.
var vramPressureMarkers = []string{
	"cannot meet free memory", "failed to fit",
}

// engineWatch reads the engine's output as it goes past and remembers the two
// things worth reporting afterwards.
//
// A writer rather than a log-file grep, which is what launch.bat had to do. The
// grep was why launch.bat needed -lv AND a log file AND a findstr pass; sitting
// in the stream needs none of that plumbing and cannot race a file that is
// still being written.
type engineWatch struct {
	mu       sync.Mutex
	tail     string
	gpu      bool
	vram     bool
	sawAny   bool
	maxSplit int

	// The load sentence is assembled from whole lines, so this keeps its own
	// line buffer alongside the byte-level marker scan above. Both are needed:
	// the markers must survive being split across writes, and the summary must
	// see complete lines to read numbers out of them.
	lines bytes.Buffer
	sum   loadSummary
}

func newEngineWatch() *engineWatch {
	// A marker split across two writes would be missed by a per-write scan, so
	// the last few bytes are carried over. Longest marker is well under 32.
	return &engineWatch{maxSplit: 32}
}

func (w *engineWatch) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if len(p) > 0 {
		w.sawAny = true
	}

	// Feed whole lines to the summary. Anything without a newline yet stays in
	// the buffer; a load's interesting lines all end in one.
	w.lines.Write(p)
	for {
		line, err := w.lines.ReadString('\n')
		if err != nil {
			w.lines.Reset()
			w.lines.WriteString(line)
			break
		}
		w.sum.Feed(strings.TrimRight(line, "\r\n"))
	}

	hay := w.tail + string(p)
	for _, m := range offloadMarkers {
		if strings.Contains(hay, m) {
			w.gpu = true
			break
		}
	}
	for _, m := range vramPressureMarkers {
		if strings.Contains(hay, m) {
			w.vram = true
			break
		}
	}
	if len(hay) > w.maxSplit {
		w.tail = hay[len(hay)-w.maxSplit:]
	} else {
		w.tail = hay
	}
	return len(p), nil
}

func (w *engineWatch) Reset() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.tail, w.gpu, w.vram, w.sawAny = "", false, false, false
	w.lines.Reset()
	// A fresh summary per load, or a swap would report the previous model's
	// layer count as if it were this one's.
	w.sum = loadSummary{}
}

// LoadLine returns the one-sentence account of the current load, or "" if the
// engine said nothing recognisable.
func (w *engineWatch) LoadLine() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.sum.Line()
}

// LoadNotes returns plain-language warnings about the current load.
func (w *engineWatch) LoadNotes() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.sum.Notes()
}

// GPUConfirmed reports that the engine said layers reached the GPU.
//
// False means "not confirmed", NOT "running on the CPU". The distinction is the
// whole of issue #33: llama.cpp files these lines above its default threshold,
// so without -lv they never arrive and every launch warns about a GPU that is
// working perfectly well. BuildArgs passes -lv for this reason, and
// tests/test-engine-args.py holds the two together.
func (w *engineWatch) GPUConfirmed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.gpu
}

// VRAMPressure reports that the engine complained about fitting the model.
func (w *engineWatch) VRAMPressure() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.vram
}

// SawOutput reports whether the engine said anything at all. Distinguishes "the
// GPU was not confirmed" from "we never heard from the engine", which need
// different things said about them.
func (w *engineWatch) SawOutput() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.sawAny
}

// AwaitGPUVerdict gives the engine's output a moment to arrive before anyone
// asks whether the GPU was used.
//
// WHY A WAIT IS NEEDED AT ALL. Boot() returns when llama.cpp's /health answers
// 200, and llama.cpp prints its offload lines before it starts listening -- so
// in wall-clock terms the lines come first. But they travel through a pipe and
// are scanned by another goroutine, so "the engine has printed it" and "we have
// read it" are different instants. Reading the verdict the moment Boot returns
// loses that race often enough to matter, and the failure is the worst kind:
// a confident "could not confirm GPU acceleration" on a machine whose GPU is
// working perfectly.
//
// Returns as soon as the marker is seen, so a healthy GPU costs nothing. The
// full wait is only paid on a machine that genuinely has no offload lines,
// which is the case that is about to print a long warning anyway.
func (s *Supervisor) AwaitGPUVerdict(within time.Duration) {
	deadline := time.Now().Add(within)
	for {
		if s.engine.GPUConfirmed() {
			return
		}
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// announceLoad prints the one-line account of a completed load.
//
// Called on every path that brings a model up -- boot, swap, and the reload
// after standing down -- because the console should read the same whichever one
// happened. The alternative was a line in each, which is how Boot came to
// confirm GPU offload and a swap did not.
//
// tag and verb belong to the caller so the line still says which KIND of load
// this was: a swap is something the user asked for, a stand-down reload is the
// app catching up with them, and telling those apart from the console is the
// whole point of the tags.
//
// NOT gated on show_engine_output. That setting decides whether llama.cpp's own
// output is mirrored; this line is GobboNet's, in GobboNet's words, and it is
// the one line the setting exists to make unnecessary.
func (s *Supervisor) announceLoad(tag, verb, file string, started time.Time) {
	// The same race AwaitGPUVerdict exists for: /health answers before the
	// offload lines have been read out of the pipe. Waiting on the layer split
	// specifically, since that is the number the sentence is built around.
	deadline := time.Now().Add(2 * time.Second)
	for !s.engine.sawLayerSplit() && time.Now().Before(deadline) {
		time.Sleep(25 * time.Millisecond)
	}

	took := time.Since(started).Truncate(100 * time.Millisecond)
	if line := s.engine.LoadLine(); line != "" {
		log.Printf("[%s] %s %s in %s %s", tag, verb, filepath.Base(file), took, line)
	} else {
		// Nothing recognisable came back. Still worth a line: the load
		// finishing is the event, and the detail is a bonus.
		log.Printf("[%s] %s %s in %s", tag, verb, filepath.Base(file), took)
	}
	for _, n := range s.engine.LoadNotes() {
		log.Printf("[%s] note: %s", tag, n)
	}
}

// LoadSummaryLine and LoadNotes expose the load sentence to cmd/gobbonet,
// whose banner reports the boot load in its own voice rather than through
// announceLoad. AwaitGPUVerdict is the caller's job there, as it already was.
func (s *Supervisor) LoadSummaryLine() string { return s.engine.LoadLine() }

// LoadNotes are the plain-language warnings about the current load.
func (s *Supervisor) LoadNotes() []string { return s.engine.LoadNotes() }

func (w *engineWatch) sawLayerSplit() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.sum.sawSplit
}
