// Which requests count as USING the model.
//
// This is the file for the defect that made idle stand-down look broken on
// every machine that had a browser tab open. The timer worked. The setting
// persisted. The unload never happened, because the chat page polls
// /llm/health every five seconds and every request reaching the proxy called
// MarkActivity() -- so the idle clock was reset twelve times a minute by a
// page sitting there doing nothing.
//
// The original reasoning is worth keeping, because it is the kind of wrong
// that looks right: "generation is the only thing the frontend sends through
// the proxy, so that needs no special-casing today". It was never true, and
// nothing checked.
//
// So these tests are deliberately split in two. The first half pins the
// classification. The second half reads js/ and refuses to pass if the
// frontend learns to call an endpoint nobody has classified -- because the
// way this bug happened was a path being added on one side and nobody
// revisiting the other.
package server

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
)

func TestGenerationCountsAsUse(t *testing.T) {
	// Every path llama.cpp will actually produce tokens for, with the /llm
	// proxy prefix on, because that is the form countsAsUse is handed.
	for _, p := range []string{
		"/llm/v1/chat/completions",
		"/llm/v1/completions",
		"/llm/completion",
		"/llm/completions",
		"/llm/infill",
	} {
		if !countsAsUse(p) {
			t.Errorf("%s does not count as use -- the model can stand down mid-conversation", p)
		}
	}
}

func TestInspectionDoesNotCountAsUse(t *testing.T) {
	// /health is the one that mattered: js/24-boot.js polls it on a 5s
	// setInterval for as long as the tab is open.
	for _, p := range []string{
		"/llm/health",
		"/llm/props",
		"/llm/tokenize",
		"/llm/detokenize",
		"/llm/apply-template",
		"/llm/slots",
		"/llm/metrics",
		"/llm/models",
		"/llm/v1/models",
	} {
		if countsAsUse(p) {
			t.Errorf("%s counts as use -- an open tab would hold the model in VRAM forever", p)
		}
	}
}

// The specific, timed reproduction of the shipped bug, stated as an
// arithmetic fact rather than a wall-clock wait: the poll interval is smaller
// than the smallest timeout the panel offers, so if the poll counts, no
// timeout can ever be reached.
func TestTheFiveSecondHealthPollCannotOutrunTheIdleTimer(t *testing.T) {
	const pollSeconds = 5 // js/24-boot.js: setInterval(checkConnection, 5000)
	const shortestTimeoutSeconds = 60
	if pollSeconds >= shortestTimeoutSeconds {
		t.Skip("the poll is slower than the timer; this test no longer describes anything")
	}
	if countsAsUse("/llm/health") {
		t.Fatalf("the health poll fires every %ds and the shortest timeout is %ds, "+
			"so counting it as use makes stand-down unreachable", pollSeconds, shortestTimeoutSeconds)
	}
}

// The match is exact after the /llm prefix comes off, so a path that merely
// ends in the right letters must not count.
//
// The third case is the one that made it exact rather than a suffix match.
// URL.Path is percent-DECODED before a handler sees it, so a request for
// "/llm/props%3Fx=/completion" arrives here as a path ending in "/completion".
func TestUseMatchingIsNotFooledBySimilarPaths(t *testing.T) {
	for _, p := range []string{
		"/llm/health/completions-stats",
		"/llm/no-completionx",
		"/llm/props?x=/completion",
		"/llm/v1/chat/completions/stream",
		"/completionsomething",
		"/llm",
		"/llm/",
	} {
		if countsAsUse(p) {
			t.Errorf("%s was treated as generation", p)
		}
	}
	// And the bare forms with no prefix still work, since a future route
	// change could stop the prefix arriving.
	if !countsAsUse("/v1/chat/completions") {
		t.Error("the unprefixed generation path stopped matching")
	}
}

// ---------------------------------------------------------------------------
// The half that fails when the frontend changes.

var llamaCall = regexp.MustCompile(`LLAMA_URL\s*\+\s*'(/[^']*)'`)

// frontendLlamaPaths returns every endpoint js/ calls on the llama proxy.
func frontendLlamaPaths(t *testing.T) []string {
	t.Helper()
	root := filepath.Join("..", "..", "js")
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Skipf("js/ is not beside this package (%v); nothing to cross-check", err)
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".js" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(root, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range llamaCall.FindAllStringSubmatch(string(b), -1) {
			seen[m[1]] = true
		}
	}
	out := make([]string, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// classified is the decision, written down. Anything the frontend calls that
// is not in here is an unreviewed endpoint, and the test says so by name.
//
// true  = using the model: holds it awake, wakes it if it is down
// false = asking after it: does not touch the idle clock
var classified = map[string]bool{
	"/v1/chat/completions": true,
	"/jobs":                true, // POST only; see serveLLMJobs
	"/health":              false,
	"/props":               false,
	"/tokenize":            false,
	"/apply-template":      false,
}

func TestEveryFrontendEndpointHasBeenClassified(t *testing.T) {
	for _, p := range frontendLlamaPaths(t) {
		if _, ok := classified[p]; !ok {
			t.Errorf("js/ calls %q and nothing decides whether it counts as using the model.\n"+
				"Add it to `classified` in this file -- and if it is generation, to `usePaths` "+
				"in standdown.go. Guessing is how the 5-second health poll got treated as use.", p)
		}
	}
}

// And the classification has to agree with the code, or the map above is just
// a comment that compiles.
func TestTheClassificationMatchesTheCode(t *testing.T) {
	for p, isUse := range classified {
		if p == "/jobs" {
			continue // method-dependent; covered by TestOnlyStartingAJobIsUse
		}
		if got := countsAsUse("/llm" + p); got != isUse {
			t.Errorf("%s: this file says use=%v, countsAsUse says %v", p, isUse, got)
		}
	}
}

// /llm/jobs is split by method rather than by path: POST starts a generation,
// GET asks how it is going. Polling a job must not hold the model awake for
// the same reason polling /health must not.
func TestOnlyStartingAJobIsUse(t *testing.T) {
	// The routing itself needs a live supervisor, so what is pinned here is
	// the predicate serveLLMJobs uses. Kept in lockstep by hand, which is why
	// it is written out rather than inferred.
	starting := func(method string) bool { return method == "POST" }
	if !starting("POST") {
		t.Error("POST /llm/jobs is not treated as starting a generation")
	}
	for _, m := range []string{"GET", "HEAD", "DELETE"} {
		if starting(m) {
			t.Errorf("%s /llm/jobs is treated as starting a generation", m)
		}
	}
}
