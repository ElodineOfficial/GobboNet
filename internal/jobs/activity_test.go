package jobs

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDetachedGenerationHoldsActivityUntilWorkerEnds(t *testing.T) {
	started := make(chan struct{})
	finished := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(finished)
	}))
	defer up.Close()
	m := NewManager(up.URL, "", 1, 1)
	defer m.Shutdown()
	var active atomic.Int32
	released := make(chan struct{})
	m.Acquire = func() (func(), error) { active.Add(1); return func() { active.Add(-1); close(released) }, nil }
	rec := httptest.NewRecorder()
	m.Handle(rec, httptest.NewRequest("POST", "/llm/jobs", strings.NewReader(`{"messages":[]}`)))
	if rec.Code != 202 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	if active.Load() != 1 {
		t.Fatal("HTTP 202 released active generation")
	}
	m.Shutdown()
	select {
	case <-released:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not release activity")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("upstream did not close")
	}
	if active.Load() != 0 {
		t.Fatal("activity leak")
	}
}

func TestInvalidJobDoesNotWakeAndFailedWakeDoesNotRegister(t *testing.T) {
	m := NewManager("http://127.0.0.1:1", "", 1, 1)
	defer m.Shutdown()
	calls := 0
	m.Acquire = func() (func(), error) { calls++; return nil, errors.New("test wake failure") }
	bad := httptest.NewRecorder()
	m.Handle(bad, httptest.NewRequest("POST", "/llm/jobs", strings.NewReader("invalid")))
	if calls != 0 {
		t.Fatal("invalid input woke model")
	}
	rec := httptest.NewRecorder()
	m.Handle(rec, httptest.NewRequest("POST", "/llm/jobs", strings.NewReader(`{}`)))
	if rec.Code != 503 || calls != 1 || len(m.jobs) != 0 {
		t.Fatalf("status=%d calls=%d jobs=%d", rec.Code, calls, len(m.jobs))
	}
}
