package models

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Info resolves and caches the current model identity and the model list.
//
// Where the answer comes from depends on the operating mode:
//
//	Local   the GGUF header on disk, read with gguf-parser-go. Complete and
//	        authoritative — general.architecture is always present, so there is
//	        nothing to guess and no fallback chain.
//	Remote  the upstream's /props. model_hf_architecture when the build provides
//	        it (r3170+), filename heuristics otherwise, and finally
//	        thinkingFormat "none".
//
// The final fallback degrades one thing only: the collapsible chain-of-thought
// UI. The model still generates thinking correctly, chat still works, and the
// context window is still managed from n_ctx. It is a polish feature that fades,
// not a functional failure.
type Info struct {
	llmURL   string
	apiKey   string
	modelDir string
	local    bool

	// LocalFile reports the GGUF basename the supervisor currently has loaded.
	// Set in local mode; nil in remote mode.
	LocalFile func() string

	client *http.Client

	mu        sync.Mutex
	cached    *Record
	cachedAt  time.Time
	listCache []Record
	listStamp time.Time
	listSize  int
}

const (
	propsTimeout = 5 * time.Second
	// recordCacheTTL bounds how stale the active-model answer can be. The model
	// list has no time-based TTL at all — the directory's mtime decides when to
	// re-scan, so a new GGUF appears immediately and an unchanged directory
	// costs one stat.
	recordCacheTTL = 10 * time.Second
)

// NewInfo builds a resolver. local selects GGUF-header identification.
func NewInfo(llmURL, apiKey, modelDir string, local bool) *Info {
	return &Info{
		llmURL:   llmURL,
		apiKey:   apiKey,
		modelDir: modelDir,
		local:    local,
		client:   &http.Client{Timeout: propsTimeout},
	}
}

// Props is the subset of llama.cpp's /props we consume.
type Props struct {
	ChatTemplate string `json:"chat_template"`
	ModelPath    string `json:"model_path"`
	ModelAlias   string `json:"model_alias"`
	// HFArchitecture is present on llama.cpp builds from roughly r3170 onward.
	// When absent we fall back to filename heuristics.
	HFArchitecture            string `json:"model_hf_architecture"`
	BuildInfo                 string `json:"build_info"`
	DefaultGenerationSettings struct {
		NCtx int `json:"n_ctx"`
	} `json:"default_generation_settings"`
}

// FetchProps pulls /props from the upstream. A nil result means unreachable.
func (i *Info) FetchProps() (*Props, error) {
	req, err := http.NewRequest(http.MethodGet, i.llmURL+"/props", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if i.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+i.apiKey)
	}

	resp, err := i.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream /props returned %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var props Props
	if err := json.Unmarshal(body, &props); err != nil {
		return nil, err
	}
	return &props, nil
}

// Current returns the identified active model, cached briefly. chat.html
// re-fetches active-model.json on every load and after every swap poll, and
// there is no reason to re-probe the upstream that often.
func (i *Info) Current(force bool) Record {
	i.mu.Lock()
	defer i.mu.Unlock()

	if !force && i.cached != nil && time.Since(i.cachedAt) < recordCacheTTL {
		return *i.cached
	}

	rec, ok := i.resolveLocked()
	if !ok {
		// Upstream is down. A previously resolved answer is better than a
		// placeholder, and the UI shows its own connection error either way.
		if i.cached != nil {
			return *i.cached
		}
		rec = Record{
			File:           "",
			ID:             "custom",
			Name:           "(llama.cpp server unreachable)",
			Family:         "custom",
			ThinkingFormat: "none",
			MaxCtx:         131072,
			UseJinja:       1,
		}
	}
	rec.Active = true
	i.cached = &rec
	i.cachedAt = time.Now()
	return rec
}

// resolveLocked identifies the active model. ok=false means nothing could be
// determined at all.
func (i *Info) resolveLocked() (Record, bool) {
	props, propsErr := i.FetchProps()

	if i.local {
		// Local mode: find out WHICH file is loaded, then read that file's
		// header for the metadata. The supervisor knows first-hand; /props is
		// the cross-check for a server we didn't spawn ourselves.
		name := ""
		if i.LocalFile != nil {
			name = i.LocalFile()
		}
		if name == "" && props != nil {
			name = filepath.Base(modelPathOf(props))
		}
		if name != "" && name != "." && name != "/" {
			path := filepath.Join(i.modelDir, name)
			if st, err := os.Stat(path); err == nil && st.Mode().IsRegular() {
				return IdentifyFile(path), true
			}
		}
		// The loaded GGUF isn't in model_dir (an absolute path elsewhere, or
		// the server is still starting). Fall through to the remote path rather
		// than report nothing.
	}

	if propsErr != nil || props == nil {
		return Record{}, false
	}
	return IdentifyProps(props), true
}

func modelPathOf(props *Props) string {
	if props.ModelPath != "" {
		return props.ModelPath
	}
	return props.ModelAlias
}

// IdentifyProps identifies the model a llama.cpp server currently has loaded.
//
// /props exposes chat_template (the same string embedded in the GGUF),
// model_path, and default_generation_settings.n_ctx — every input Classify
// needs, so a remote server is identified by exactly the same rules as a local
// file. No separate, drift-prone code path.
//
// Note the deliberate difference from the local case: n_ctx is the context the
// server was *launched with*, not the model's training context. Reporting it as
// maxCtx is correct here, because the server will reject anything larger no
// matter what the model could theoretically do.
func IdentifyProps(props *Props) Record {
	modelPath := modelPathOf(props)
	filename := "remote-model.gguf"
	if modelPath != "" {
		filename = filepath.Base(modelPath)
	}

	// Prefer what the build tells us; guess from the filename only if it didn't.
	arch := props.HFArchitecture
	if arch == "" {
		arch = ArchitectureFromName(filename)
	}

	// No sidecar lookup: the GGUF lives on the remote host, and a .jinja in our
	// local models/ would not be the template that server is using.
	return Classify(ClassifyInput{
		Filename:      filename,
		ChatTemplate:  props.ChatTemplate,
		Architecture:  arch,
		ContextLength: props.DefaultGenerationSettings.NCtx,
	})
}

// ActiveModelPayload is the active-model.json body loadActiveModel() expects.
func (i *Info) ActiveModelPayload(defaultCtx int) map[string]any {
	rec := i.Current(false)

	ctx := defaultCtx
	if rec.MaxCtx > 0 && rec.MaxCtx < defaultCtx {
		// The upstream's own ceiling is real; a locally configured default
		// larger than it would only produce 400s on every request.
		ctx = rec.MaxCtx
	}

	return map[string]any{
		"id":             rec.ID,
		"name":           rec.Name,
		"family":         rec.Family,
		"ggufFile":       rec.File,
		"maxCtx":         rec.MaxCtx,
		"defaultCtx":     ctx,
		"thinkingFormat": rec.ThinkingFormat,
	}
}

// ModelsListPayload is the models-list.json body backing the header dropdown.
//
// This replaces the static file that launch.bat wrote and fileserver.ps1 mutated
// on every swap — the exact drift risk that motivated this migration. The
// directory is scanned on demand and the result cached against its mtime, so
// dropping a GGUF into models/ makes it appear on the next request with no
// restart and no mutable file to fall out of sync.
func (i *Info) ModelsListPayload() map[string]any {
	active := i.Current(false)

	entries := make([]Record, 0, 8)
	seen := make(map[string]bool)

	if active.File != "" {
		entries = append(entries, active)
		seen[active.File] = true
	}

	for _, rec := range i.scanCached() {
		if seen[rec.File] {
			continue
		}
		rec.Active = rec.File == active.File
		entries = append(entries, rec)
		seen[rec.File] = true
	}

	return map[string]any{"active": active.File, "models": entries}
}

// scanCached returns the model directory listing, re-scanning only when the
// directory has changed.
func (i *Info) scanCached() []Record {
	if i.modelDir == "" {
		return nil
	}
	st, err := os.Stat(i.modelDir)
	if err != nil || !st.IsDir() {
		return nil
	}

	i.mu.Lock()
	defer i.mu.Unlock()

	// mtime alone can miss a same-second replacement, so pair it with the entry
	// count. Both unchanged means the cheap answer is also the correct one.
	size := dirEntryCount(i.modelDir)
	if i.listCache != nil && st.ModTime().Equal(i.listStamp) && size == i.listSize {
		return i.listCache
	}

	i.listCache = ScanDir(i.modelDir)
	i.listStamp = st.ModTime()
	i.listSize = size
	return i.listCache
}

func dirEntryCount(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return -1
	}
	return len(entries)
}

// Invalidate drops the cached identity, forcing the next request to re-probe.
// Called after a hot-swap completes.
func (i *Info) Invalidate() {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.cached = nil
}
