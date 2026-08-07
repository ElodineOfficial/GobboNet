// Package models identifies which model is loaded and what the UI needs to know
// about it. Port of identify-model.ps1 (and its Python translation).
//
// Detection is driven by the embedded tokenizer.chat_template, which is ground
// truth, with filename rules as hard overrides for families whose embedded
// template is known-broken. The same function serves three callers — the
// models-list builder, the active-model payload, and the hot-swap launch-command
// builder. Detection living in exactly one place is why the dropdown, the swap
// launcher and the initial launch can never disagree with each other.
//
// Thinking-format names mirror chat.html's registry:
//
//	none      no thinking (Llama, Mistral, Phi, Gemma 3 base)
//	deepseek  <think>...</think>  (R1, Qwen3, QwQ, GLM thinking, ...)
//	harmony   gpt-oss channels
//	gemma     Gemma channel thinking (Gemma 4)
package models

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

// MaxCtxCap bounds what we advertise to the UI regardless of what a header
// claims. Some GGUFs report absurd training contexts that no local machine can
// actually allocate.
const MaxCtxCap = 262144

// Record is one entry in models-list.json. The JSON names are what chat.html
// and the swap launcher read, so this serialises straight to the wire.
type Record struct {
	File             string `json:"file"`
	ID               string `json:"id"`
	Name             string `json:"name"`
	Family           string `json:"family"`
	ThinkingFormat   string `json:"thinkingFormat"`
	MaxCtx           int    `json:"maxCtx"`
	UseJinja         int    `json:"useJinja"`
	ChatTemplate     string `json:"chatTemplate"`
	ChatTemplateFile string `json:"chatTemplateFile"`
	TemplateHash     string `json:"templateHash"`
	Active           bool   `json:"active"`
}

type derivation struct {
	family, id string
	jinja      int
	builtin    string
	think      string
}

// hashDerivations recognises chat templates byte-for-byte.
//
// Hashing the template is stronger than any filename heuristic: a re-quantized
// upload keeps the template even when the filename has been mangled beyond
// recognition.
var hashDerivations = map[string]derivation{
	"e10ca381b1ccc5cf9db52e371f3b6651576caee0a630b452e2816b2d404d4b65": {"llama", "llama", 1, "", "none"},
	"5816fce10444e03c2e9ee1ef8a4a1ea61ae7e69e438613f3b17b69d0426223a4": {"llama", "llama", 1, "", "none"},
	"73e87b1667d87ab7d7b579107f01151b29ce7f3ccdd1018fdc397e78be76219d": {"llama", "llama", 1, "", "none"},

	// Every Mistral hash keeps the embedded Jinja (jinja=1) to prevent system
	// prompt loss.
	"e16746b40344d6c5b5265988e0328a0bf7277be86f1c335156eae07e29c82826": {"mistral", "mistral", 1, "", "none"},
	"26a59556925c987317ce5291811ba3b7f32ec4c647c400c6cc7e3a9993007ba7": {"mistral", "mistral", 1, "", "none"},
	"e4676cb56dffea7782fd3e2b577cfaf1e123537e6ef49b3ec7caa6c095c62272": {"mistral", "mistral-nemo", 1, "", "none"},
	"3c4ad5fa60dd8c7ccdf82fa4225864c903e107728fcaf859fa6052cb80c92ee9": {"mistral", "mistral", 1, "", "none"},
	"3934d199bfe5b6fab5cba1b5f8ee475e8d5738ac315f21cb09545b4e665cc005": {"mistral", "mistral-small", 1, "", "none"},

	"ecd6ae513fe103f0eb62e8ab5bfa8d0fe45c1074fa398b089c93a7e70c15cfd6": {"gemma", "gemma3", 1, "", "none"},
	"87fa45af6cdc3d6a9e4dd34a0a6848eceaa73a35dcfe976bd2946a5822a38bf3": {"gemma", "gemma3", 1, "", "none"},
	"7de1c58e208eda46e9c7f86397df37ec49883aeece39fb961e0a6b24088dd3c4": {"gemma", "gemma3", 1, "", "none"},
	"3b54f5c219ae1caa5c0bb2cdc7c001863ca6807cf888e4240e8739fa7eb9e02e": {"command-r", "command-r", 1, "", "none"},
	"ac7498a36a719da630e99d48e6ebc4409de85a77556c2b6159eeb735bcbd11df": {"tulu", "tulu", 1, "", "none"},
	"54d400beedcd17f464e10063e0577f6f798fa896266a912d8a366f8a2fcc0bca": {"deepseek", "deepseek", 1, "", "none"},
	"b6835114b7303ddd78919a82e4d9f7d8c26ed0d7dfc36beeb12d524f6144eab1": {"deepseek", "deepseek-r1", 1, "", "deepseek"},

	// GLM-4-9B-Chat (2024 original, dense, non-thinking). chat.html's registry
	// key is 'glm-4-9b', so that is the id we emit; family stays 'glm' so the
	// rest of the family (Z1, Air, Flash, MoE) shares a bucket.
	"854b703e44ca06bdb196cc471c728d15dbab61e744fe6cdce980086b61646ed1": {"glm", "glm-4-9b", 1, "", "none"},
	"aab20feb9bc6881f941ea649356130ffbc4943b3c2577c0991e1fba90de5a0fc": {"moonshot", "moonshot", 1, "", "none"},
	"70da0d2348e40aaf8dad05f04a316835fd10547bd7e3392ce337e4c79ba91c01": {"gpt-oss", "gpt-oss", 1, "", "harmony"},
	"a4c9919cbbd4acdd51ccffe22da049264b1b73e59055fa58811a99efbd7c8146": {"gpt-oss", "gpt-oss", 1, "", "harmony"},
}

var (
	ggufSuffixRe = regexp.MustCompile(`(?i)\.gguf$`)

	reMistralSmall  = regexp.MustCompile(`cydonia|asmodeus|mistral[-_.]?small`)
	reMistralNemo   = regexp.MustCompile(`nemo|violet[-_]?lotus|rocinante|magnum`)
	reGranite       = regexp.MustCompile(`granite`)
	reThink         = regexp.MustCompile(`think`)
	reLlama3        = regexp.MustCompile(`llama[-_]?[3]`)
	reCommandR      = regexp.MustCompile(`command[-_.]?r|c4ai`)
	reR7B           = regexp.MustCompile(`r7b|r[-_.]?7b|7b[-_.]?12[-_.]?2024`)
	reR7BShort      = regexp.MustCompile(`r7b|r[-_.]?7b`)
	reThinkOrReason = regexp.MustCompile(`think|reason`)

	reGLMFlash  = regexp.MustCompile(`flash`)
	reGLMAir    = regexp.MustCompile(`air`)
	reGLMZ132   = regexp.MustCompile(`z1[\-_.]?32|z1.+32b`)
	reGLMZ1     = regexp.MustCompile(`z1`)
	reGLM432B   = regexp.MustCompile(`glm[\-_.]?4[\-_.]?32b|glm4[\-_.]?32b`)
	reGLMBigMoE = regexp.MustCompile(`glm[\-_.]?(?:4\.[5-9]|5(?:\.\d+)?)`)
)

// TemplateHash is the SHA-256 of the trimmed template, lowercase hex.
//
// Trailing NULs and surrounding whitespace are stripped first, so the same
// template embedded by two different quantizers hashes identically.
func TemplateHash(template string) string {
	trimmed := strings.TrimSpace(strings.Trim(template, "\x00"))
	if trimmed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(trimmed))
	return hex.EncodeToString(sum[:])
}

// applyGLMVariant picks the GLM registry id from the filename.
//
// Architecture alone is too coarse: Flash 9B, Z1 9B, 4-32B, Air 106B and the big
// MoE flagships can all share an arch string ('glm4' dense, 'glm4moe' MoE).
func applyGLMVariant(rec *Record, nameLC string) {
	switch {
	case reGLMFlash.MatchString(nameLC):
		rec.ID, rec.ThinkingFormat = "glm-flash", "deepseek"
	case reGLMAir.MatchString(nameLC):
		rec.ID, rec.ThinkingFormat = "glm-air", "deepseek"
	case reGLMZ132.MatchString(nameLC):
		rec.ID, rec.ThinkingFormat = "glm-z1-32b", "deepseek"
	case reGLMZ1.MatchString(nameLC):
		rec.ID, rec.ThinkingFormat = "glm-z1-9b", "deepseek"
	case reGLM432B.MatchString(nameLC):
		rec.ID, rec.ThinkingFormat = "glm-4-32b", "none"
	case reGLMBigMoE.MatchString(nameLC):
		rec.ID, rec.ThinkingFormat = "glm-big-moe", "deepseek"
	default:
		rec.ID, rec.ThinkingFormat = "glm-4-9b", "none"
	}
}

// ClassifyInput is everything the identification core can use. Callers supply
// whatever they have; a caller with only a filename gets the filename-driven
// result, which is what the PowerShell did when Read-GgufMeta returned $null.
type ClassifyInput struct {
	Filename      string
	ChatTemplate  string
	Architecture  string
	ContextLength int
	// SidecarFile is a validated .jinja next to the GGUF, filename only.
	SidecarFile string
	// SidecarPrefix is prepended to SidecarFile in the emitted record so the
	// swap launcher can resolve it. Defaults to "models".
	SidecarPrefix string
}

// Classify is the identification core, independent of where the metadata came
// from.
func Classify(in ClassifyInput) Record {
	name := ggufSuffixRe.ReplaceAllString(in.Filename, "")
	nameLC := strings.ToLower(name)

	rec := Record{
		File:           in.Filename,
		Name:           name,
		ID:             "custom",
		Family:         "custom",
		ThinkingFormat: "none",
		MaxCtx:         131072,
		UseJinja:       1,
	}

	prefix := in.SidecarPrefix
	if prefix == "" {
		prefix = "models"
	}

	// --- Sidecar check first -------------------------------------------------
	// A validated sidecar overrides the hardcoded safety nets below.
	if in.SidecarFile != "" {
		rec.ChatTemplateFile = prefix + "/" + in.SidecarFile
		rec.UseJinja = 1
		sidecarLC := strings.ToLower(in.SidecarFile)
		switch {
		case strings.Contains(sidecarLC, "mistral"):
			rec.Family, rec.ID = "mistral", "mistral"
		case strings.Contains(sidecarLC, "granite"):
			rec.Family, rec.ID = "granite", "granite"
		case strings.Contains(sidecarLC, "glm"), strings.Contains(sidecarLC, "chatglm"):
			// Community guides for GLM-4.5+/4.6V-Flash/Air tell users to drop a
			// corrected Jinja next to the GGUF, because the embedded template
			// has known issues parsing reasoning content during tool calls. We
			// don't bundle one; we just recognise it when the user supplies it.
			rec.Family = "glm"
			applyGLMVariant(&rec, strings.ToLower(in.Filename))
		}
	}

	if rec.ChatTemplateFile == "" {
		// --- Hard overrides --------------------------------------------------

		// Mistral Small 24B and its mergekit merges (Asmodeus, Cydonia, ...)
		// ship an embedded v7-tekken template, but on mergekit children that
		// template can be malformed — mergekit copies tokenizer_config from one
		// parent at random. The reliable path is llama.cpp's built-in C++
		// Mistral v7 template.
		//
		// "mistral-v7", NOT "mistral-v7-tekken": the -tekken variant landed in
		// llama.cpp's built-in name table much later. On builds that predate it,
		// llama-server does not recognise the name, and because the string still
		// begins with "mistral" its content-detector treats the literal text as
		// the template *body* — rendering a constant ~8-token string for every
		// request, so the model never sees the conversation and just talks about
		// "tekken".
		if reMistralSmall.MatchString(nameLC) {
			rec.Family, rec.ID = "mistral", "mistral-small"
			rec.UseJinja, rec.ChatTemplate = 0, "mistral-v7"
			return rec
		}
		if reMistralNemo.MatchString(nameLC) {
			rec.Family, rec.ID = "mistral", "mistral-nemo"
			rec.UseJinja, rec.ChatTemplate = 0, "mistral-v3-tekken"
			return rec
		}
		// Granite: the embedded template crashes the loader AND the built-in
		// name doesn't resolve on current builds.
		if reGranite.MatchString(nameLC) {
			rec.Family, rec.ID, rec.UseJinja, rec.ChatTemplate = "granite", "granite", 1, ""
			if reThink.MatchString(nameLC) {
				rec.ThinkingFormat = "deepseek"
			}
			return rec
		}
		// Llama 3 / 3.1 / 3.2.
		if reLlama3.MatchString(nameLC) {
			rec.Family, rec.ID, rec.UseJinja, rec.ChatTemplate = "llama", "llama", 1, ""
			return rec
		}
		// Command R (Cohere). Both eras ship a clean embedded jinja template
		// using <|START_OF_TURN_TOKEN|> markers which renders fine with --jinja,
		// so no built-in override is needed. No thinking format — Command R is
		// instruct-style, not chain-of-thought.
		if reCommandR.MatchString(nameLC) {
			rec.Family, rec.UseJinja, rec.ChatTemplate = "cohere", 1, ""
			if reR7B.MatchString(nameLC) {
				rec.ID = "command-r7b"
			} else {
				rec.ID = "command-r-35b"
			}
			return rec
		}
	}

	template := in.ChatTemplate
	arch := strings.ToLower(in.Architecture)

	if template == "" && arch == "" && in.ContextLength <= 0 {
		// No metadata at all: mirror the PowerShell's $null-meta fallback.
		if rec.ChatTemplateFile != "" {
			return rec
		}
		if reThinkOrReason.MatchString(nameLC) {
			rec.ThinkingFormat = "deepseek"
		}
		return rec
	}

	if in.ContextLength > 0 {
		rec.MaxCtx = min(in.ContextLength, MaxCtxCap)
	}

	digest := TemplateHash(template)
	rec.TemplateHash = digest

	// A resolved sidecar wins; just check for thinking markers and return.
	if rec.ChatTemplateFile != "" {
		if strings.Contains(arch, "deepseek") || strings.Contains(template, "<think>") {
			rec.ThinkingFormat = "deepseek"
		}
		return rec
	}

	if d, ok := hashDerivations[digest]; ok && digest != "" {
		rec.Family, rec.ID, rec.UseJinja = d.family, d.id, d.jinja
		rec.ChatTemplate, rec.ThinkingFormat = d.builtin, d.think
		if d.family == "gemma" && in.ContextLength > 131072 {
			rec.ID, rec.ThinkingFormat = "gemma4", "gemma"
		}
		return rec
	}

	hasInst := strings.Contains(template, "[INST]")
	hasTools := strings.Contains(template, "[AVAILABLE_TOOLS]")

	switch {
	case strings.Contains(template, "<|channel|>"),
		strings.Contains(arch, "gpt-oss"), strings.Contains(arch, "gptoss"), strings.Contains(arch, "gpt_oss"):
		rec.Family, rec.ID, rec.UseJinja, rec.ThinkingFormat = "gpt-oss", "gpt-oss", 1, "harmony"

	case strings.Contains(template, "<|START_OF_TURN_TOKEN|>"), strings.HasPrefix(arch, "cohere"):
		// Cohere's tokens are unambiguous — no other family uses
		// START_OF_TURN_TOKEN. Both Cohere (35B) and Cohere2 (7B) arch values
		// are caught by the prefix. thinkingFormat stays 'none'.
		rec.Family, rec.UseJinja = "cohere", 1
		if arch == "cohere2" || reR7BShort.MatchString(nameLC) {
			rec.ID = "command-r7b"
		} else {
			rec.ID = "command-r-35b"
		}

	case strings.Contains(template, "[gMASK]"), strings.Contains(template, "<sop>"),
		strings.HasPrefix(arch, "glm"), arch == "chatglm":
		// GLM family (Z.ai / Zhipu / THUDM). Two template eras coexist:
		//   1. 2024-era GLM-4-9B-Chat (arch 'chatglm'/'glm4', no [gMASK]): the
		//      embedded template is what llama.cpp ships as built-in 'chatglm4',
		//      so we disable --jinja and use the built-in.
		//   2. 0414-era and 4.5+ era: no built-in name covers this format, so we
		//      keep --jinja and rely on the embedded template.
		rec.Family, rec.UseJinja, rec.ChatTemplate = "glm", 1, ""
		applyGLMVariant(&rec, nameLC)
		if rec.ID == "glm-4-9b" {
			// Reached only for variants whose template hash drifted (community
			// quantizations that re-embed the template).
			rec.UseJinja, rec.ChatTemplate = 0, "chatglm4"
		}
		// Final override: if the embedded template literally contains <think>,
		// force deepseek thinking regardless of filename. Covers fine-tunes
		// whose uploader patched <think> in.
		if strings.Contains(template, "<think>") {
			rec.ThinkingFormat = "deepseek"
		}

	case strings.Contains(template, "<|im_user|>") && strings.Contains(template, "<|im_middle|>"):
		rec.Family, rec.ID, rec.UseJinja = "moonshot", "moonshot", 1

	case strings.Contains(template, "<|im_start|>"):
		rec.UseJinja = 1
		switch {
		case strings.HasPrefix(arch, "qwen"):
			rec.Family, rec.ID = "qwen", "qwen"
		case strings.HasPrefix(arch, "phi"):
			rec.Family, rec.ID = "phi", "phi"
		case arch != "":
			rec.Family, rec.ID = arch, arch
		default:
			rec.Family, rec.ID = "custom", "custom"
		}
		if strings.Contains(template, "<think>") || arch == "qwen3" || arch == "qwen3moe" {
			rec.ThinkingFormat = "deepseek"
		}

	case strings.Contains(template, "<start_of_turn>"), strings.HasPrefix(arch, "gemma"):
		rec.Family, rec.UseJinja = "gemma", 1
		if in.ContextLength > 131072 {
			rec.ID, rec.ThinkingFormat = "gemma4", "gemma"
		} else {
			rec.ID, rec.ThinkingFormat = "gemma3", "none"
		}

	case hasInst, hasTools:
		rec.Family, rec.ID, rec.UseJinja, rec.ChatTemplate = "mistral", "mistral", 1, ""

	default:
		switch {
		case strings.Contains(arch, "deepseek"):
			rec.Family, rec.ID, rec.ThinkingFormat = "deepseek", "deepseek", "deepseek"
		case strings.HasPrefix(arch, "llama"), arch == "":
			rec.Family, rec.ID = "llama", "llama"
		default:
			rec.Family, rec.ID = arch, arch
		}
	}

	if rec.ThinkingFormat == "none" && strings.Contains(template, "<think>") {
		rec.ThinkingFormat = "deepseek"
	}
	return rec
}

// archFromName recovers a GGUF architecture string from a filename.
//
// Architecture is the one identification input a remote llama.cpp server may not
// report: older /props exposes the chat template and model path but not
// general.architecture. Without it, Classify falls to its arch == "" branch and
// labels a perfectly recognisable model 'custom' — the thinking format still
// comes out right (it is template-driven), but chat.html's registry lookup
// misses and the UI shows a generic display name and context hint.
//
// These are deliberately coarse prefix rules over names quantizers actually
// publish; anything unmatched returns "" and behaves exactly as before.
var archFromName = []struct {
	re   *regexp.Regexp
	arch string
}{
	{regexp.MustCompile(`qwen[-_.]?3(?:\.\d+)?.*(?:a\d+b|moe)`), "qwen3moe"},
	{regexp.MustCompile(`qwen[-_.]?3`), "qwen3"},
	{regexp.MustCompile(`qwen`), "qwen2"},
	{regexp.MustCompile(`deepseek`), "deepseek2"},
	{regexp.MustCompile(`phi[-_.]?\d`), "phi3"},
	{regexp.MustCompile(`gemma`), "gemma3"},
	{regexp.MustCompile(`llama|tulu|hermes`), "llama"},
	{regexp.MustCompile(`cohere|command[-_.]?r|c4ai`), "cohere"},
	{regexp.MustCompile(`glm|chatglm`), "glm4"},
}

// ArchitectureFromName is a best-effort architecture string inferred from a
// model filename.
func ArchitectureFromName(filename string) string {
	nameLC := strings.ToLower(filename)
	for _, entry := range archFromName {
		if entry.re.MatchString(nameLC) {
			return entry.arch
		}
	}
	return ""
}
