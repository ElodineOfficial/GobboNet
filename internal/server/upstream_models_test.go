package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The engines these have to satisfy answer the same endpoint with different
// content, so both real shapes are pinned rather than one invented one.

// llama.cpp reports the single model it has loaded, id being the file path it
// was started with.
const llamacppModels = `{"object":"list","data":[
 {"id":"/models/Cydonia-24B-v2.1-Q4_K_M.gguf","object":"model","created":0,"owned_by":"llamacpp"}
]}`

// Ollama reports everything installed, tag included, and loads on demand.
const ollamaModels = `{"object":"list","data":[
 {"id":"qwen3:30b","object":"model","created":1,"owned_by":"library"},
 {"id":"llama3.2:latest","object":"model","created":2,"owned_by":"library"},
 {"id":"gemma3:12b","object":"model","created":3,"owned_by":"library"}
]}`

func modelServer(t *testing.T, status int, body string, seen *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seen != nil {
			*seen = r.URL.Path
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestReadsLlamaCppModelList -- the #48/#47 case: a llama.cpp server the user
// runs themselves, which GobboNet never asked about.
func TestReadsLlamaCppModelList(t *testing.T) {
	srv := modelServer(t, 200, llamacppModels, nil)
	ids, err := fetchUpstreamModelIDs(srv.URL, "")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(ids) != 1 || !strings.HasSuffix(ids[0], "Cydonia-24B-v2.1-Q4_K_M.gguf") {
		t.Errorf("ids = %v", ids)
	}
}

// TestReadsOllamaModelList -- #27. joeypent69 could not pick between models he
// already had installed; this is the list he should have been seeing.
func TestReadsOllamaModelList(t *testing.T) {
	srv := modelServer(t, 200, ollamaModels, nil)
	ids, err := fetchUpstreamModelIDs(srv.URL, "")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(ids) != 3 {
		t.Fatalf("ids = %v, want 3", ids)
	}
	// Sorted, so the dropdown does not reshuffle under a user mid-click.
	want := []string{"gemma3:12b", "llama3.2:latest", "qwen3:30b"}
	for i := range want {
		if ids[i] != want[i] {
			t.Errorf("ids = %v, want %v", ids, want)
			break
		}
	}
}

// TestBaseURLNormalisation. llm_url is documented as the server root, but both
// engines PRINT urls carrying /v1, and people paste what they were shown.
// Appending blindly gives /v1/v1/models -> 404 -> "the upstream has no models",
// which is the exact failure this file exists to remove.
func TestBaseURLNormalisation(t *testing.T) {
	for _, base := range []string{
		"http://127.0.0.1:11434",
		"http://127.0.0.1:11434/",
		"http://127.0.0.1:11434/v1",
		"http://127.0.0.1:11434/v1/",
		"http://127.0.0.1:11434/v1/models",
	} {
		if got := upstreamModelsURL(base); got != "http://127.0.0.1:11434/v1/models" {
			t.Errorf("upstreamModelsURL(%q) = %q", base, got)
		}
	}
}

func TestRequestsTheV1ModelsPath(t *testing.T) {
	var seen string
	srv := modelServer(t, 200, ollamaModels, &seen)
	if _, err := fetchUpstreamModelIDs(srv.URL, ""); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if seen != "/v1/models" {
		t.Errorf("requested %q, want /v1/models", seen)
	}
}

// TestAPIKeyIsSent -- a remote llama.cpp behind --api-key answers 401, which
// without the header presents as "the server has no models" rather than "you
// are not authorised". Same wrong conclusion as the original bug.
func TestAPIKeyIsSent(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		fmt.Fprint(w, ollamaModels)
	}))
	defer srv.Close()

	if _, err := fetchUpstreamModelIDs(srv.URL, "sk-secret"); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if auth != "Bearer sk-secret" {
		t.Errorf("Authorization = %q", auth)
	}
}

// TestErrorsAreDistinctFromEmpty is the reporting half of #47. "Asked, got
// nothing" and "could not ask" produce identical empty dropdowns, and the
// reporter had no way to tell us which one he was looking at.
func TestErrorsAreDistinctFromEmpty(t *testing.T) {
	empty := modelServer(t, 200, `{"object":"list","data":[]}`, nil)
	ids, err := fetchUpstreamModelIDs(empty.URL, "")
	if err != nil || len(ids) != 0 {
		t.Errorf("empty list: ids=%v err=%v -- want no error and no ids", ids, err)
	}

	dead := modelServer(t, 500, `nope`, nil)
	if _, err := fetchUpstreamModelIDs(dead.URL, ""); err == nil {
		t.Error("a 500 must be an error, not an empty list")
	}

	if _, err := fetchUpstreamModelIDs("", ""); err == nil {
		t.Error("an empty llm_url must be an error")
	}
}

// TestGarbageResponseIsAnError. Pointing llm_url at something that is not an
// OpenAI-compatible server at all -- a web server, the wrong port -- must not
// silently render as an empty model list.
func TestGarbageResponseIsAnError(t *testing.T) {
	srv := modelServer(t, 200, `<html><body>hello</body></html>`, nil)
	if _, err := fetchUpstreamModelIDs(srv.URL, ""); err == nil {
		t.Error("non-JSON body accepted as a model list")
	}
}

// TestBlankAndDuplicateIDsAreDropped -- a blank id renders as an unselectable
// blank row in the dropdown.
func TestBlankAndDuplicateIDsAreDropped(t *testing.T) {
	srv := modelServer(t, 200,
		`{"data":[{"id":"a"},{"id":""},{"id":"a"},{"id":"  "},{"id":"b"}]}`, nil)
	ids, err := fetchUpstreamModelIDs(srv.URL, "")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if len(ids) != 2 || ids[0] != "a" || ids[1] != "b" {
		t.Errorf("ids = %v, want [a b]", ids)
	}
}

// TestUpstreamRecordsShape. These rows go through the same dropdown code as
// local ones, so they must carry the fields it reads -- and the remote flag,
// without which the UI would POST /swap-model and ask a server we do not
// manage to restart a process that is not ours.
func TestUpstreamRecordsShape(t *testing.T) {
	recs := upstreamRecords([]string{"qwen3:30b", "gemma3:12b"}, "gemma3:12b")
	if len(recs) != 2 {
		t.Fatalf("got %d records", len(recs))
	}
	for _, r := range recs {
		for _, k := range []string{"file", "id", "name", "family", "thinkingFormat", "remote", "active"} {
			if _, ok := r[k]; !ok {
				t.Errorf("record %v missing %q", r, k)
			}
		}
		if r["remote"] != true {
			t.Errorf("record %v not marked remote", r)
		}
	}
	if recs[0]["active"] != false || recs[1]["active"] != true {
		t.Errorf("active flag landed on the wrong row: %v", recs)
	}
	// file is the handle the <option> value is built from. For a remote model
	// the id IS the handle, the way a filename is for a local one.
	if recs[0]["file"] != "qwen3:30b" {
		t.Errorf("file = %v, want the model id", recs[0]["file"])
	}
}
