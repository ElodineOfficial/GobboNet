package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Asking the upstream what it is serving.
//
// Closes #47, #48 and #27, which are one bug reported three ways:
//
//   - #48 asked whether GobboNet can point at a llama.cpp server it does not
//     manage. It can, and always could: server_exe = "" plus llm_url is remote
//     mode. Nothing said so.
//   - #47 did exactly that on Artix, and the model dropdown said "None".
//   - #27 did it against Ollama and could not select between installed models.
//
// The dropdown is built from ModelsListPayload, which scans model_dir for
// .gguf files. In remote mode there are no local files -- the models live on
// the other machine, or inside Ollama's blob store -- so the scan correctly
// returns nothing and the UI correctly renders nothing. Every layer behaved,
// and the user got an empty list pointed at a server with eight models loaded.
//
// Nothing anywhere in the Go server asked the upstream. `grep -rn "v1/models"`
// returned no matches at all. That is the whole defect.
//
// Both engines answer the same OpenAI-shaped endpoint -- llama.cpp reports the
// model it has loaded, Ollama reports everything installed and loads on demand
// -- so one request covers both, and the workaround #27 has been living with
// (`ollama cp <model> local`, to satisfy a hardcoded model name) stops being
// necessary.

// upstreamModelTTL bounds how stale the remote list may be.
//
// Short, because in remote mode the list is someone else's to change: a user
// who runs `ollama pull` in another window should see the new model without
// restarting GobboNet. Long enough that a browser polling the dropdown does not
// turn into a request amplifier against the upstream.
const upstreamModelTTL = 15 * time.Second

// upstreamModelTimeout is deliberately short. This runs inside the request that
// paints the dropdown, and a remote llama.cpp that has gone away must degrade to
// an empty list quickly rather than hanging the model picker.
const upstreamModelTimeout = 3 * time.Second

// upstreamModels caches the last answer from {llm_url}/v1/models.
type upstreamModels struct {
	mu      sync.Mutex
	ids     []string
	checked time.Time
	err     error
}

// openAIModelList is the response shape both llama.cpp and Ollama return.
// Only the id is read: everything else in the object is engine-specific and
// nothing in the UI needs it.
type openAIModelList struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

// UpstreamModelIDs returns the model ids the configured upstream is serving.
//
// Empty slice and a nil error means "asked, got nothing" -- a legitimate answer
// from an engine with no model loaded. A non-nil error means we could not ask,
// which the caller reports differently: an empty dropdown with no explanation
// is the exact failure #47 filed.
func (s *Server) UpstreamModelIDs() ([]string, error) {
	s.upstreamList.mu.Lock()
	defer s.upstreamList.mu.Unlock()

	if !s.upstreamList.checked.IsZero() && time.Since(s.upstreamList.checked) < upstreamModelTTL {
		return s.upstreamList.ids, s.upstreamList.err
	}

	ids, err := fetchUpstreamModelIDs(s.cfg.LLMURL, s.cfg.LLMAPIKey)
	s.upstreamList.ids, s.upstreamList.err = ids, err
	s.upstreamList.checked = time.Now()
	return ids, err
}

// fetchUpstreamModelIDs performs the request. Split from the cache so it can be
// tested against a httptest server without a Server around it.
func fetchUpstreamModelIDs(baseURL, apiKey string) ([]string, error) {
	if strings.TrimSpace(baseURL) == "" {
		return nil, fmt.Errorf("no llm_url configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), upstreamModelTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamModelsURL(baseURL), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	// The key never reaches the browser; it is config-side only, exactly as it
	// is for the chat proxy. Sent because a remote llama.cpp behind --api-key
	// rejects an unauthenticated /v1/models with 401, and that would present as
	// "the server has no models" rather than "you are not authorised".
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream /v1/models returned %d", resp.StatusCode)
	}

	var parsed openAIModelList
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("upstream /v1/models is not an OpenAI model list: %w", err)
	}

	ids := make([]string, 0, len(parsed.Data))
	seen := make(map[string]bool)
	for _, m := range parsed.Data {
		id := strings.TrimSpace(m.ID)
		// An engine that reports a blank id gives the user an unselectable
		// blank row; drop it rather than rendering it.
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	// Ollama returns installation order, llama.cpp returns one entry. Sorting
	// makes the dropdown stable across polls so it does not reshuffle under a
	// user who is mid-click.
	sort.Strings(ids)
	return ids, nil
}

// upstreamModelsURL joins the configured base to /v1/models.
//
// llm_url is documented as the server root ("http://127.0.0.1:11434"), but
// people paste what their engine printed, and both llama.cpp and Ollama print
// URLs that already carry /v1. Appending blindly yields /v1/v1/models and a 404
// that reads exactly like "the upstream has no models" -- the failure this file
// exists to remove. So normalise instead of trusting the shape.
func upstreamModelsURL(baseURL string) string {
	u := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	switch {
	case strings.HasSuffix(u, "/v1/models"):
		return u
	case strings.HasSuffix(u, "/v1"):
		return u + "/models"
	}
	return u + "/v1/models"
}

// upstreamRecords turns the ids into dropdown rows.
//
// The Record shape is what the header dropdown already consumes, so remote
// models render through the same path as local ones with no second code path in
// the UI. File carries the id because that is what the <option> value is built
// from and what comes back on selection -- for a remote model the id IS the
// handle, the way a filename is for a local one.
//
// Remote is set so the frontend can tell the two apart where it matters: a
// local swap restarts llama-server, while a remote "swap" only changes which
// model name we put in the next request. Sending /swap-model for a server we do
// not manage would be meaningless at best.
func upstreamRecords(ids []string, active string) []map[string]any {
	out := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		out = append(out, map[string]any{
			"file":           id,
			"id":             id,
			"name":           id,
			"family":         "remote",
			"thinkingFormat": "none",
			"remote":         true,
			"active":         id == active,
		})
	}
	return out
}
