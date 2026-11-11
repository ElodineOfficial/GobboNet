package server

// POST /model-check   {"index": N, "source": "catalogue" | "huggingface"}
// GET  /model-check   the check's progress and result
//
// CHECK FILE in Add a Model (1.8.0, issue #67): re-hash a catalogue model that
// is already installed and compare it with a reference. The usual answer to "a
// model fails to load with 'data is not within the file bounds'" is a download
// that was cut short, and until now there was no way to find out short of
// downloading it again.
//
// Two references, and the difference between them is the network:
//
//   - "catalogue" compares with the SHA-256 the catalogue pins for the file.
//     The catalogue is the one Add a Model has already loaded, so nothing new
//     leaves the machine. A catalogue entry with no pin has nothing to compare
//     with, and says so without hashing anything.
//   - "huggingface" first asks huggingface.co for the checksum it records for
//     the file -- one request, made only because the user clicked "Ask
//     HuggingFace" -- and then compares. When the catalogue pins one too and
//     the two disagree, that is the answer, as it is for a download.
//
// The client names a catalogue index, never a path or a file name, as a
// download does: the server resolves it to the entry and to a plain file name
// in the models folder. One check at a time; hashing a 20 GB file takes a
// while, and a second one would only slow both down.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/catalog"
	"github.com/ElodineOfficial/GobboNet/internal/httpx"
	"github.com/ElodineOfficial/GobboNet/internal/modelfetch"
	"github.com/ElodineOfficial/GobboNet/internal/models"
)

// modelCheckStatus is what GET /model-check answers.
type modelCheckStatus struct {
	State   string  `json:"state"` // idle | running | done | error
	Index   int     `json:"index"`
	Display string  `json:"display,omitempty"`
	File    string  `json:"file,omitempty"`
	Source  string  `json:"source,omitempty"` // catalogue | huggingface
	Percent float64 `json:"percent"`
	Done    int64   `json:"done"`
	Total   int64   `json:"total"`
	// Result: match | mismatch | no-reference | disagree. Expected and Got are
	// the two checksums compared, when there were two.
	Result   string `json:"result,omitempty"`
	Expected string `json:"expected,omitempty"`
	Got      string `json:"got,omitempty"`
	Message  string `json:"message,omitempty"`
}

type modelChecker struct {
	mu sync.Mutex
	st modelCheckStatus
	// hostBase replaces https://huggingface.co in tests.
	hostBase string
}

func (c *modelChecker) get() modelCheckStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.st
}

func (c *modelChecker) update(f func(*modelCheckStatus)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	f(&c.st)
}

func (s *Server) handleModelCheck(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		st := s.check.get()
		if st.State == "" {
			st.State = "idle"
		}
		httpx.WriteJSON(w, r, http.StatusOK, st)
		return
	case http.MethodPost:
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET or POST only")
		return
	}
	if !sameOriginOrNone(r) {
		httpx.Error(w, r, http.StatusForbidden, "CHECK FILE runs from GobboNet's own page")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<10))
	if err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "could not read body")
		return
	}
	var in struct {
		Index  *int   `json:"index"`
		Source string `json:"source"`
	}
	if json.Unmarshal(raw, &in) != nil || in.Index == nil {
		httpx.Error(w, r, http.StatusBadRequest, `send {"index": N, "source": "catalogue"}`)
		return
	}
	if in.Source == "" {
		in.Source = "catalogue"
	}
	if in.Source != "catalogue" && in.Source != "huggingface" {
		httpx.Error(w, r, http.StatusBadRequest, `source is "catalogue" or "huggingface"`)
		return
	}
	cat := s.resolvedCatalog()
	if cat == nil {
		httpx.Error(w, r, http.StatusConflict, "Open Add a Model first: the catalogue is not loaded.")
		return
	}
	var entry catalog.Entry
	found := false
	for _, e := range cat.Entries {
		if e.Index == *in.Index {
			entry, found = e, true
			break
		}
	}
	if !found {
		httpx.Error(w, r, http.StatusNotFound, "No model with that number in the catalogue.")
		return
	}
	if models.CheckFileName(entry.File) != nil {
		httpx.Error(w, r, http.StatusBadRequest, "That catalogue entry does not name a plain .gguf file.")
		return
	}
	path := filepath.Join(s.modelDir(), entry.File)
	if fi, err := os.Stat(path); err != nil || !fi.Mode().IsRegular() {
		httpx.Error(w, r, http.StatusNotFound, entry.Display+" is not installed, so there is nothing to check.")
		return
	}

	s.check.mu.Lock()
	if s.check.st.State == "running" {
		s.check.mu.Unlock()
		httpx.Error(w, r, http.StatusConflict, "A check is already running. Wait for it to finish.")
		return
	}
	pin := strings.ToLower(strings.TrimSpace(entry.SHA256))
	s.check.st = modelCheckStatus{State: "running", Index: entry.Index, Display: entry.Display, File: entry.File, Source: in.Source}
	if in.Source == "catalogue" && pin == "" {
		// Nothing offline to compare with: say so now, without reading 20 GB
		// to reach the same answer.
		s.check.st.State = "done"
		s.check.st.Result = "no-reference"
		s.check.st.Message = "The catalogue publishes no checksum for " + entry.Display +
			", so there is nothing on this PC to compare it with. Ask HuggingFace sends one request to huggingface.co for the checksum it records."
		st := s.check.st
		s.check.mu.Unlock()
		httpx.WriteJSON(w, r, http.StatusOK, st)
		return
	}
	st := s.check.st
	s.check.mu.Unlock()

	go s.runModelCheck(entry, path, in.Source, pin)
	httpx.WriteJSON(w, r, http.StatusAccepted, st)
}

func (s *Server) runModelCheck(entry catalog.Entry, path, source, pin string) {
	want, ref := pin, "the checksum the catalogue publishes"
	if source == "huggingface" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		pointer, err := modelfetch.PointerSum(ctx, entry, s.check.hostBase)
		cancel()
		log.Printf("[check] %s: asked HuggingFace for its checksum: %v", entry.File, errOrOK(err))
		if err != nil {
			s.check.update(func(st *modelCheckStatus) {
				st.State = "error"
				st.Message = "HuggingFace could not be asked: " + err.Error() + ". Nothing was checked."
			})
			return
		}
		if pin != "" && pin != pointer {
			s.check.update(func(st *modelCheckStatus) {
				st.State = "done"
				st.Result = "disagree"
				st.Expected, st.Got = pin, pointer
				st.Message = "The catalogue and HuggingFace disagree about " + entry.Display +
					"'s checksum, so one of them is out of date or the file was replaced upstream. The file itself was not read."
			})
			return
		}
		want, ref = pointer, "the checksum HuggingFace records"
	}

	began := time.Now()
	got, err := modelfetch.HashFile(context.Background(), path, func(done, total int64) {
		s.check.update(func(st *modelCheckStatus) {
			st.Done, st.Total = done, total
			if total > 0 {
				st.Percent = float64(done) * 100 / float64(total)
			}
		})
	})
	if err != nil {
		log.Printf("[check] %s: could not read it: %v", entry.File, err)
		s.check.update(func(st *modelCheckStatus) {
			st.State = "error"
			st.Message = "The file could not be read: " + err.Error()
		})
		return
	}
	log.Printf("[check] %s: hashed in %s", entry.File, time.Since(began).Round(time.Second))
	s.check.update(func(st *modelCheckStatus) {
		st.State = "done"
		st.Expected, st.Got = want, got
		if got == want {
			st.Result = "match"
			st.Message = entry.Display + " matches " + ref + ". The file is complete and unchanged."
		} else {
			st.Result = "mismatch"
			st.Message = entry.Display + " does not match " + ref + ": it is incomplete, damaged, or a different file with the same name. Delete it from the models folder and download it again here."
		}
	})
}

func errOrOK(err error) string {
	if err != nil {
		return err.Error()
	}
	return "ok"
}
