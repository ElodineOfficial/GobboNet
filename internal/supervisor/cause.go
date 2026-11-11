package supervisor

import (
	"errors"
	"strings"
)

// Why a model failed to load, in words a user can act on (1.8.0, issue #67).
//
// llama.cpp prints the reason a load failed a few lines before it signs off,
// and the sign-off -- "main: exiting due to model loading error" -- is the
// last line, and holds the word "error". LastError used to scan from the end
// for any such word, so the sign-off won every time and the user was told only
// that the model had not loaded. The reason was in the buffer all along.
//
// So the whole buffer is searched for a known cause first, and each cause
// comes with one plain sentence and one thing to do. The markers are
// llama.cpp b10456's own wording, read from its source: gguf.cpp,
// llama-model-loader.cpp, llama-model.cpp, ggml-vulkan.cpp, ggml-cuda.cu,
// ggml-backend.cpp. A later engine that rewords them falls back to the generic
// scan, which no longer lets the sign-off win either.

// The cause keys. Stable: /swap-status carries them as "cause".
const (
	CauseEngineTooOld   = "engine_too_old"
	CauseIncompleteFile = "incomplete_file"
	CauseOutOfMemory    = "out_of_memory"
	CauseFileNotFound   = "file_not_found"
)

var causeMarkers = []struct {
	cause   string
	markers []string
}{
	// llama-model.cpp: "unknown model architecture: '%s'"
	{CauseEngineTooOld, []string{"unknown model architecture"}},
	// llama-model-loader.cpp: "tensor '%s' data is not within the file bounds,
	// model is corrupted or incomplete"; gguf.cpp: "failed to read magic",
	// "invalid magic characters"; a truncated read of the header or tensor info.
	{CauseIncompleteFile, []string{
		"not within the file bounds", "model is corrupted or incomplete",
		"failed to read magic", "invalid magic characters",
		"failed to read tensor info", "failed to read header",
	}},
	// ggml-backend.cpp: "failed to allocate %s buffer of size"; ggml-vulkan.cpp:
	// "ErrorOutOfDeviceMemory", "Device memory allocation of size %zu failed";
	// ggml-cuda.cu: "cudaMalloc failed: out of memory".
	{CauseOutOfMemory, []string{
		"failed to allocate", "erroroutofdevicememory", "erroroutofhostmemory",
		"out of memory", "memory allocation of size", "unable to allocate",
	}},
	// gguf.cpp: "failed to open GGUF file '%s'"; and the OS's own words.
	{CauseFileNotFound, []string{"failed to open", "no such file or directory"}},
}

// summaryLines are llama.cpp saying THAT the load failed, not why. They are
// the last resort for a reason, never the first.
var summaryLines = []string{
	"exiting due to model loading error",
	"failed to load model",
	"error: failed to load",
}

func isSummaryLine(lower string) bool {
	for _, s := range summaryLines {
		if strings.Contains(lower, s) {
			return true
		}
	}
	return false
}

// findCause returns the known cause in text and the line that shows it, or
// ("", "") when there is none. The latest matching line wins: it is the one
// closest to the failure.
func findCause(text string) (cause, line string) {
	lines := strings.Split(text, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if l == "" {
			continue
		}
		lower := strings.ToLower(l)
		for _, c := range causeMarkers {
			for _, m := range c.markers {
				if strings.Contains(lower, m) {
					return c.cause, truncate(l, 400)
				}
			}
		}
	}
	return "", ""
}

// CauseAdvice is the one sentence a user is told for a cause key: what went
// wrong and the one thing to do. "" for an unknown key.
func CauseAdvice(cause string) string {
	switch cause {
	case CauseEngineTooOld:
		return "This model needs a newer engine than the one GobboNet runs. Pick another model, or update GobboNet."
	case CauseIncompleteFile:
		return "The model file is incomplete or damaged. Use CHECK FILE in Add a Model, or download it again."
	case CauseOutOfMemory:
		return "Not enough GPU or system memory for this model. Lower the context size or GPU layers in CONFIG > Performance, or pick a smaller model."
	case CauseFileNotFound:
		return "The model file is missing from the models folder."
	}
	return ""
}

// LoadError is a failed load, with what llama.cpp said about it. Error() is
// llama.cpp's own line, as it always was, so every message built from it reads
// as before; Cause is the key for the plain sentence beside it.
type LoadError struct {
	Cause string
	Line  string
}

func (e *LoadError) Error() string { return e.Line }

// causeOf finds the cause key in err, or "".
func causeOf(err error) string {
	var le *LoadError
	if errors.As(err, &le) {
		return le.Cause
	}
	return ""
}

// failure reads the captured stderr for why the engine failed: a known cause
// and its line, else the generic scan. nil when nothing was said.
func (r *ringBuffer) failure() *LoadError {
	text := r.String()
	if cause, line := findCause(text); cause != "" {
		return &LoadError{Cause: cause, Line: line}
	}
	if line := lastErrorIn(text); line != "" {
		return &LoadError{Line: line}
	}
	return nil
}

// logRunMarker begins each engine run in llama-server.log; the model's file
// name follows it.
const logRunMarker = "=== GobboNet: starting llama-server for "

// listeningMarkers are llama-server's words for a load that worked.
var listeningMarkers = []string{"server is listening on", "main: model loaded"}

// LastRun is what llama-server.log says about the most recent engine run.
type LastRun struct {
	Model    string     // the file the run was for; "" in a log from before 1.8.0
	Marked   bool       // the log has run markers (1.8.0 and later)
	Loaded   bool       // the engine got as far as listening
	Failure  *LoadError // why not, when it said
	HasLines bool       // anything was written for this run at all
}

// LastRunInLog reads the tail of llama-server.log for gobbonet doctor, which
// runs on the PC and has no session to ask the server with. Only the text
// after the last run marker counts, so an old failure is not reported once a
// later load has worked.
func LastRunInLog(text string) LastRun {
	var run LastRun
	if i := strings.LastIndex(text, logRunMarker); i >= 0 {
		run.Marked = true
		rest := text[i+len(logRunMarker):]
		if j := strings.Index(rest, " at "); j >= 0 && j < 300 {
			run.Model = rest[:j]
		}
		if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
			text = rest[nl+1:]
		} else {
			text = ""
		}
	}
	run.HasLines = strings.TrimSpace(text) != ""
	lower := strings.ToLower(text)
	for _, m := range listeningMarkers {
		if strings.Contains(lower, m) {
			run.Loaded = true
		}
	}
	if !run.Loaded {
		if cause, line := findCause(text); cause != "" {
			run.Failure = &LoadError{Cause: cause, Line: line}
		} else if line := lastErrorIn(text); line != "" {
			run.Failure = &LoadError{Line: line}
		}
	}
	return run
}

// lastRunText is the part of llama-server.log after the last run marker, or
// all of it in a log from before 1.8.0.
func lastRunText(text string) string {
	if i := strings.LastIndex(text, logRunMarker); i >= 0 {
		rest := text[i:]
		if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
			return rest[nl+1:]
		}
		return ""
	}
	return text
}

// LastLoadSummary is the console's load sentence ("on NVIDIA GeForce MX940 --
// 12 of 33 layers on the GPU, ...") rebuilt from the last run in
// llama-server.log, for gobbonet doctor (1.8.0, #72). "" when the log does not
// say where the model went.
func LastLoadSummary(text string) string {
	var sum loadSummary
	for _, line := range strings.Split(lastRunText(text), "\n") {
		sum.Feed(line)
	}
	return sum.Line()
}
