package models

import (
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	gguf "github.com/gpustack/gguf-parser-go"
	"sync"
)

// GGUFMeta is the subset of a GGUF header that identification needs.
type GGUFMeta struct {
	Architecture  string
	ChatTemplate  string
	ContextLength int
}

// ReadGGUFMeta pulls general.architecture, tokenizer.chat_template and
// <arch>.context_length out of a GGUF file.
//
// gguf-parser-go reads only the header region, not the tensor payload, so this
// costs a few KB of IO against a multi-gigabyte file. That is what makes
// scanning a whole models/ directory on demand practical.
//
// In local mode this is the complete and authoritative source — no filename
// guessing, no fallbacks. A GGUF always carries general.architecture.
func ReadGGUFMeta(path string) (*GGUFMeta, error) {
	f, err := gguf.ParseGGUFFile(path, gguf.UseMMap())
	if err != nil {
		return nil, err
	}

	meta := &GGUFMeta{
		Architecture:  f.Metadata().Architecture,
		ContextLength: int(f.Architecture().MaximumContextLength),
	}
	if kv, ok := f.Header.MetadataKV.Get("tokenizer.chat_template"); ok {
		meta.ChatTemplate = kv.ValueString()
	}
	return meta, nil
}

// --- Sidecar templates -----------------------------------------------------

// UsableTemplate reports whether a candidate .jinja actually contains a chat
// template, or is junk we must NOT hand to llama-server.
//
// The motivating bug: a sidecar shipped next to a model was a *failed download*
// whose entire body was the 15-byte HTTP 404 string "Entry not found". Passed to
// --chat-template-file, that becomes a constant-string "template" — it renders
// to the same few words for every turn, the model never sees the conversation,
// and it free-associates.
//
// A real Jinja chat template always contains control or output markers. Anything
// without them is rejected here so we fall through to the built-in template.
func UsableTemplate(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	text := strings.TrimSpace(strings.Trim(string(raw), "\x00"))
	if len(text) < 16 {
		return false
	}
	if strings.EqualFold(text, "entry not found") {
		return false
	}
	return strings.Contains(text, "{%") || strings.Contains(text, "{{")
}

// sidecarNameMatches pairs a .jinja sidecar with a GGUF stem. The label may be
// joined to the stem by '.', '_' or '-' (e.g. "<stem>.granite.jinja",
// "<stem>_mistral-v7-tekken.jinja"), or be a bare "<stem>.jinja".
func sidecarNameMatches(nameLC, stemLC string) bool {
	if nameLC == stemLC+".jinja" {
		return true
	}
	return strings.HasPrefix(nameLC, stemLC+".") ||
		strings.HasPrefix(nameLC, stemLC+"_") ||
		strings.HasPrefix(nameLC, stemLC+"-")
}

// FindSidecarTemplate returns the basename of a validated .jinja sitting next to
// ggufPath, or "" if there isn't one.
func FindSidecarTemplate(ggufPath string) string {
	dir := filepath.Dir(ggufPath)
	stemLC := strings.ToLower(ggufSuffixRe.ReplaceAllString(filepath.Base(ggufPath), ""))

	entries, err := filepath.Glob(filepath.Join(dir, "*.jinja"))
	if err != nil {
		return ""
	}
	sort.Strings(entries)
	for _, candidate := range entries {
		base := filepath.Base(candidate)
		if sidecarNameMatches(strings.ToLower(base), stemLC) && UsableTemplate(candidate) {
			return base
		}
	}
	return ""
}

// IdentifyFile identifies a local GGUF, reading its header for ground truth.
func IdentifyFile(path string) Record {
	meta, err := ReadGGUFMeta(path)
	return identifyFrom(path, meta, err)
}

// identifyFrom is IdentifyFile with the header already read, so a directory
// scan pays for it once.
func identifyFrom(path string, meta *GGUFMeta, err error) Record {
	sidecar := FindSidecarTemplate(path)
	base := filepath.Base(path)

	if err != nil {
		// The header could not be read — a truncated download, a permissions
		// problem, or a format this parser doesn't know. Fall back to the
		// filename rules, which is what the PowerShell did when Read-GgufMeta
		// returned $null.
		//
		// Say so rather than degrade quietly: a GGUF we can't parse is one
		// llama-server will probably refuse to load too, and "the dropdown
		// labelled it 'custom'" is a much worse first clue than the real error.
		warnOnce(base, func() {
			log.Printf("[models] could not read GGUF header from %s: %v (falling back to filename rules)", base, err)
		})
		// Guess the architecture from the name, exactly as IdentifyProps does
		// when a build predates model_hf_architecture. Both are the degraded
		// path; there is no reason for a local file to be identified less well
		// than the same file behind a remote server.
		return Classify(ClassifyInput{
			Filename:     base,
			Architecture: ArchitectureFromName(base),
			SidecarFile:  sidecar,
		})
	}
	return Classify(ClassifyInput{
		Filename:      base,
		ChatTemplate:  meta.ChatTemplate,
		Architecture:  meta.Architecture,
		ContextLength: meta.ContextLength,
		SidecarFile:   sidecar,
	})
}

var ggufGlobRe = regexp.MustCompile(`(?i)\.gguf$`)

// projectorNameRe matches the naming convention llama.cpp's own conversion
// scripts use for multimodal projectors, which is what every quantizer on
// Hugging Face follows.
var projectorNameRe = regexp.MustCompile(`(?i)(^|[-_.])mmproj([-_.]|$)`)

// isProjector reports whether a GGUF is a multimodal projector rather than a
// model that can be loaded for chat.
//
// Vision models ship the projector as a second .gguf right next to the weights
// — LM Studio and Hugging Face both lay them out that way — so a plain scan of
// model_dir picks them up. They are not chat models: llama-server takes one via
// --mmproj alongside a real --model, and handed one as --model it refuses to
// load. Listing them in the dropdown offers the user a choice that can only
// fail, and the failure looks like a broken swap rather than a bad pick.
//
// The header is authoritative (projectors declare architecture "clip"); the
// filename rule only decides files whose header could not be read at all.
func isProjector(name string, meta *GGUFMeta, err error) bool {
	if err == nil && meta != nil {
		switch strings.ToLower(meta.Architecture) {
		case "clip", "mmproj", "projector":
			return true
		}
		return false
	}
	return projectorNameRe.MatchString(name)
}

// embeddingNameRe catches the embedding models people actually have, by name,
// for when the GGUF header cannot be read.
var embeddingNameRe = regexp.MustCompile(`(?i)(nomic-embed|[-_.]embed(ding)?[-_.]|^embed|bge-[a-z]*(base|large|small)|gte-[a-z]*(base|large|small)|e5-[a-z]*(base|large|small))`)

// isEmbeddingOnly reports whether a GGUF is an embedding model rather than
// something you can hold a conversation with.
//
// WHY THIS EXISTS. The optional RAG feature downloads nomic-embed-text into the
// same models/ folder as the chat models, and ScanDir handed it back like any
// other. So it appeared in the model dropdown, and selecting it swapped the
// CHAT model to an embedding model -- launched with --jinja and
// --reasoning-format, no --embeddings flag, on the chat port. It loads, and
// then every reply is nonsense. In a real 1.7.4 session it was swapped in, ran
// for eleven minutes, and was swapped back out, with this in the console:
//
//	[swap] active model is now nomic-embed-text-v1.5.Q8_0.gguf
//	llama_context: n_ctx_seq (32768) > n_ctx_train (2048) -- possible overflow
//
// Both lines were technically present and neither says what is wrong. The
// second one now also arrives in plain language -- see loadSummary.Notes --
// but the real fix is not offering the file in the first place.
//
// The architecture is the reliable signal; the filename is the fallback for a
// header that will not read, exactly as isProjector does it.
func isEmbeddingOnly(name string, meta *GGUFMeta, err error) bool {
	if err == nil && meta != nil {
		switch strings.ToLower(meta.Architecture) {
		case "bert", "nomic-bert", "nomic-bert-moe", "jina-bert-v2", "jina-bert-v3",
			"gte", "new", "xlm-roberta":
			return true
		}
		// A known architecture that is not on that list is chat-capable, and
		// the name is not consulted -- a chat model called "embedder-7b" is
		// still a chat model.
		return false
	}
	return embeddingNameRe.MatchString(name)
}

// ScanDir identifies every chat-capable GGUF in dir, sorted by filename.
//
// Chat-capable is the operative word: projectors and embedding models live in
// the same folder and are not things you can talk to.
func ScanDir(dir string) []Record {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() || !ggufGlobRe.MatchString(e.Name()) {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)

	records := make([]Record, 0, len(names))
	for _, name := range names {
		path := filepath.Join(dir, name)
		meta, metaErr := ReadGGUFMeta(path)
		if isEmbeddingOnly(name, meta, metaErr) {
			continue
		}
		if isProjector(name, meta, metaErr) {
			continue
		}
		records = append(records, identifyFrom(path, meta, metaErr))
	}
	return records
}

// warnOnce runs fn the first time it is called for a given file.
//
// One unreadable GGUF used to be announced twice on every boot, because two
// unrelated callers both read its header: Boot's ScanDir, to find a model at
// all, and start's IdentifyFile, to decide what flags to launch it with. Both
// were right to look and both were right to complain, and the user heard the
// same sentence twice.
//
// Worth a mutex and a map because of who reads this console. It is spoken by a
// screen reader, one line at a time, in the order it arrives -- a duplicate is
// not a glance-over, it is the same sentence read out again, and a model
// directory with four bad files would say it eight times before the app
// started.
//
// Keyed by base name and never cleared: the point is one warning per run, and a
// file that becomes readable mid-session is not a case worth carrying state for.
var (
	warnedMu    sync.Mutex
	warnedFiles = map[string]bool{}
)

func warnOnce(file string, fn func()) {
	warnedMu.Lock()
	first := !warnedFiles[file]
	warnedFiles[file] = true
	warnedMu.Unlock()
	if first {
		fn()
	}
}

// ForgetWarningsForTest lets a test start from a clean slate, since the map is
// deliberately never cleared in normal operation.
func ForgetWarningsForTest() {
	warnedMu.Lock()
	warnedFiles = map[string]bool{}
	warnedMu.Unlock()
}
