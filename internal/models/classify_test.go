package models

import (
	"errors"
	"strings"
	"testing"
)

// The classifier is a line-by-line port of identify-model.ps1, and every rule in
// it exists because some model rendered garbage without it. These cases pin the
// rules whose absence produced a specific, diagnosed failure.
func TestClassifyHardOverrides(t *testing.T) {
	cases := []struct {
		name    string
		in      ClassifyInput
		want    Record
		checkFn func(*testing.T, Record)
	}{
		{
			// mergekit children of Mistral Small ship a malformed embedded
			// template, so we must force the built-in C++ one.
			name: "mistral small forces builtin v7",
			in:   ClassifyInput{Filename: "Cydonia-24B-v2.Q4_K_M.gguf"},
			checkFn: func(t *testing.T, got Record) {
				if got.ChatTemplate != "mistral-v7" {
					t.Errorf("chatTemplate: got %q, want mistral-v7", got.ChatTemplate)
				}
				if got.UseJinja != 0 {
					t.Error("useJinja must be 0 so llama.cpp uses the built-in template")
				}
				if got.ID != "mistral-small" {
					t.Errorf("id: got %q, want mistral-small", got.ID)
				}
			},
		},
		{
			name: "nemo forces v3-tekken",
			in:   ClassifyInput{Filename: "Rocinante-12B-v1.1-Q6_K.gguf"},
			checkFn: func(t *testing.T, got Record) {
				if got.ChatTemplate != "mistral-v3-tekken" || got.UseJinja != 0 {
					t.Errorf("got template=%q jinja=%d, want mistral-v3-tekken/0", got.ChatTemplate, got.UseJinja)
				}
			},
		},
		{
			// "mistral-v7-tekken" is not a built-in name on the pinned build;
			// passed bare it renders as a literal constant string.
			name: "v7-tekken never survives classification",
			in:   ClassifyInput{Filename: "Mistral-Small-Instruct.gguf"},
			checkFn: func(t *testing.T, got Record) {
				if got.ChatTemplate == "mistral-v7-tekken" {
					t.Error("mistral-v7-tekken leaked through; llama-server would treat it as a template body")
				}
			},
		},
		{
			name: "granite thinking variant",
			in:   ClassifyInput{Filename: "granite-3.2-8b-instruct-thinking.gguf"},
			checkFn: func(t *testing.T, got Record) {
				if got.Family != "granite" {
					t.Errorf("family: got %q, want granite", got.Family)
				}
				if got.ThinkingFormat != "deepseek" {
					t.Errorf("thinkingFormat: got %q, want deepseek", got.ThinkingFormat)
				}
			},
		},
		{
			name: "command-r 7b vs 35b",
			in:   ClassifyInput{Filename: "c4ai-command-r7b-12-2024-Q5_K_M.gguf"},
			checkFn: func(t *testing.T, got Record) {
				if got.ID != "command-r7b" {
					t.Errorf("id: got %q, want command-r7b", got.ID)
				}
				if got.ThinkingFormat != "none" {
					t.Errorf("Command R is instruct-style: got thinkingFormat %q, want none", got.ThinkingFormat)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Classify(tc.in)
			tc.checkFn(t, got)
		})
	}
}

func TestClassifyTemplateDriven(t *testing.T) {
	t.Run("gpt-oss channels select harmony", func(t *testing.T) {
		got := Classify(ClassifyInput{
			Filename:     "some-unrecognisable-name.gguf",
			ChatTemplate: "{% if x %}<|channel|>analysis{% endif %}",
		})
		if got.ThinkingFormat != "harmony" {
			t.Errorf("thinkingFormat: got %q, want harmony", got.ThinkingFormat)
		}
		if got.Family != "gpt-oss" {
			t.Errorf("family: got %q, want gpt-oss", got.Family)
		}
	})

	t.Run("qwen3 arch implies deepseek thinking", func(t *testing.T) {
		got := Classify(ClassifyInput{
			Filename:     "Qwen3-14B-Q4_K_M.gguf",
			ChatTemplate: "{% for m in messages %}<|im_start|>{{m.role}}{% endfor %}",
			Architecture: "qwen3",
		})
		if got.ThinkingFormat != "deepseek" {
			t.Errorf("thinkingFormat: got %q, want deepseek", got.ThinkingFormat)
		}
		if got.Family != "qwen" {
			t.Errorf("family: got %q, want qwen", got.Family)
		}
	})

	t.Run("embedded think tag overrides a none default", func(t *testing.T) {
		// A fine-tune whose uploader patched <think> into the template must be
		// detected even though nothing about the name or arch suggests it.
		got := Classify(ClassifyInput{
			Filename:     "somebodys-merge.gguf",
			ChatTemplate: "{% if add_generation_prompt %}<think>{% endif %}",
			Architecture: "llama",
		})
		if got.ThinkingFormat != "deepseek" {
			t.Errorf("thinkingFormat: got %q, want deepseek", got.ThinkingFormat)
		}
	})

	t.Run("gemma over 131072 context is gemma4", func(t *testing.T) {
		got := Classify(ClassifyInput{
			Filename:      "gemma-4-27b-it.gguf",
			ChatTemplate:  "<start_of_turn>user",
			Architecture:  "gemma3",
			ContextLength: 262144,
		})
		if got.ID != "gemma4" || got.ThinkingFormat != "gemma" {
			t.Errorf("got id=%q thinking=%q, want gemma4/gemma", got.ID, got.ThinkingFormat)
		}
	})

	t.Run("context length is capped", func(t *testing.T) {
		got := Classify(ClassifyInput{
			Filename:      "huge.gguf",
			Architecture:  "llama",
			ContextLength: 100_000_000,
		})
		if got.MaxCtx != MaxCtxCap {
			t.Errorf("maxCtx: got %d, want %d", got.MaxCtx, MaxCtxCap)
		}
	})
}

func TestClassifyGLMVariants(t *testing.T) {
	// Architecture alone can't separate these — they share 'glm4'/'glm4moe' —
	// so the filename decides, and each maps to a different chat.html registry
	// key with a different thinking format.
	cases := []struct {
		filename string
		wantID   string
		wantMode string
	}{
		{"GLM-4.5-Air-Q4_K_M.gguf", "glm-air", "deepseek"},
		{"GLM-4-Flash-Q8_0.gguf", "glm-flash", "deepseek"},
		{"GLM-Z1-32B-0414.gguf", "glm-z1-32b", "deepseek"},
		{"GLM-Z1-9B-0414.gguf", "glm-z1-9b", "deepseek"},
		{"glm-4-32b-0414.gguf", "glm-4-32b", "none"},
		{"GLM-4.6-Q4.gguf", "glm-big-moe", "deepseek"},
	}
	for _, tc := range cases {
		t.Run(tc.filename, func(t *testing.T) {
			got := Classify(ClassifyInput{
				Filename:     tc.filename,
				ChatTemplate: "[gMASK]<sop>",
				Architecture: "glm4",
			})
			if got.ID != tc.wantID {
				t.Errorf("id: got %q, want %q", got.ID, tc.wantID)
			}
			if got.ThinkingFormat != tc.wantMode {
				t.Errorf("thinkingFormat: got %q, want %q", got.ThinkingFormat, tc.wantMode)
			}
		})
	}
}

func TestClassifyNoMetadataFallback(t *testing.T) {
	// The Read-GgufMeta-returned-null path: filename rules only.
	got := Classify(ClassifyInput{Filename: "MyModel-Reasoning-v2.gguf"})
	if got.ThinkingFormat != "deepseek" {
		t.Errorf("thinkingFormat: got %q, want deepseek", got.ThinkingFormat)
	}

	got = Classify(ClassifyInput{Filename: "utterly-anonymous.gguf"})
	if got.ThinkingFormat != "none" {
		t.Errorf("thinkingFormat: got %q, want none", got.ThinkingFormat)
	}
	if got.Family != "custom" {
		t.Errorf("family: got %q, want custom", got.Family)
	}
}

func TestClassifySidecarWins(t *testing.T) {
	// A validated sidecar overrides the hardcoded safety nets: without this,
	// a user who supplied a corrected GLM template would still get the
	// built-in.
	got := Classify(ClassifyInput{
		Filename:    "Cydonia-24B.gguf",
		SidecarFile: "Cydonia-24B.mistral.jinja",
	})
	if got.ChatTemplateFile != "models/Cydonia-24B.mistral.jinja" {
		t.Errorf("chatTemplateFile: got %q", got.ChatTemplateFile)
	}
	if got.UseJinja != 1 {
		t.Error("a sidecar must force --jinja on")
	}
	if got.ChatTemplate != "" {
		t.Errorf("chatTemplate must be cleared so it can't collide with the file: got %q", got.ChatTemplate)
	}
}

func TestTemplateHashIsWhitespaceStable(t *testing.T) {
	// Two quantizers embedding the same template with different trailing NULs
	// or whitespace must produce the same hash, or the derivation table misses.
	base := "{% for m in messages %}{{ m.content }}{% endfor %}"
	if TemplateHash(base) != TemplateHash("  "+base+"\n\x00\x00") {
		t.Error("template hash changed with surrounding whitespace/NULs")
	}
	if TemplateHash("") != "" {
		t.Error("an empty template must hash to the empty string, not a digest of nothing")
	}
}

func TestArchitectureFromName(t *testing.T) {
	cases := map[string]string{
		"Qwen3-30B-A3B-Q4_K_M.gguf": "qwen3moe",
		"Qwen3-8B.gguf":             "qwen3",
		"Qwen2.5-7B.gguf":           "qwen2",
		"DeepSeek-R1-Distill.gguf":  "deepseek2",
		"gemma-3-12b-it.gguf":       "gemma3",
		"Meta-Llama-3.1-8B.gguf":    "llama",
		"unrecognisable.gguf":       "",
	}
	for filename, want := range cases {
		if got := ArchitectureFromName(filename); got != want {
			t.Errorf("%s: got %q, want %q", filename, got, want)
		}
	}
}

// Remote identification must produce the same answer as local for the same
// inputs — that is the whole point of routing both through Classify.
func TestIdentifyPropsUsesReportedArchitecture(t *testing.T) {
	props := &Props{
		ChatTemplate:   "{% for m in messages %}<|im_start|>{{m.role}}{% endfor %}",
		ModelPath:      "/srv/models/Some-Renamed-File.gguf",
		HFArchitecture: "qwen3",
	}
	props.DefaultGenerationSettings.NCtx = 40960

	got := IdentifyProps(props)
	if got.Family != "qwen" {
		t.Errorf("family: got %q, want qwen -- model_hf_architecture was ignored", got.Family)
	}
	if got.ThinkingFormat != "deepseek" {
		t.Errorf("thinkingFormat: got %q, want deepseek", got.ThinkingFormat)
	}
	// n_ctx is what the server was launched with, and it is the real ceiling.
	if got.MaxCtx != 40960 {
		t.Errorf("maxCtx: got %d, want 40960", got.MaxCtx)
	}
	if got.File != "Some-Renamed-File.gguf" {
		t.Errorf("file: got %q, want the basename of model_path", got.File)
	}
}

// Without model_hf_architecture the filename heuristic has to carry it.
func TestIdentifyPropsFallsBackToFilename(t *testing.T) {
	props := &Props{
		ChatTemplate: "{% for m in messages %}<|im_start|>{{m.role}}{% endfor %}",
		ModelPath:    "/srv/models/Qwen3-14B-Q4_K_M.gguf",
	}
	got := IdentifyProps(props)
	if got.Family != "qwen" {
		t.Errorf("family: got %q, want qwen from the filename fallback", got.Family)
	}
}

// The final fallback must still produce a usable record rather than an error.
func TestIdentifyPropsDegradesGracefully(t *testing.T) {
	got := IdentifyProps(&Props{})
	if got.ThinkingFormat != "none" {
		t.Errorf("thinkingFormat: got %q, want none", got.ThinkingFormat)
	}
	if got.MaxCtx <= 0 {
		t.Error("maxCtx must stay positive so the UI has a context budget to work with")
	}
}

// Context length is orthogonal to template identity. The filename hard
// overrides return early to pin a chat template; they must not also pin the
// context window, or the most common models — llama3, mistral-small,
// mistral-nemo, granite, command-r — all report the 131072 placeholder.
//
// In remote mode ContextLength is the n_ctx the upstream was launched with, so
// getting this wrong makes the UI offer a window llama.cpp rejects on every
// request past the real limit.
func TestHardOverridesStillHonourContextLength(t *testing.T) {
	cases := []struct {
		name     string
		filename string
		wantID   string
	}{
		{"mistral-small", "Mistral-Small-24B-Instruct-Q4_K_M.gguf", "mistral-small"},
		{"mistral-nemo", "Mistral-Nemo-Instruct-2407-Q4_K_M.gguf", "mistral-nemo"},
		{"granite", "granite-3.1-8b-instruct-Q4_K_M.gguf", "granite"},
		{"llama3", "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf", "llama"},
		{"command-r", "c4ai-command-r-08-2024-Q4_K_M.gguf", "command-r-35b"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := Classify(ClassifyInput{Filename: tc.filename, ContextLength: 8192})
			if rec.ID != tc.wantID {
				t.Fatalf("override did not fire: id = %q, want %q", rec.ID, tc.wantID)
			}
			if rec.MaxCtx != 8192 {
				t.Errorf("maxCtx = %d, want 8192 — the override discarded the real context length", rec.MaxCtx)
			}
		})
	}
}

// A sidecar template also pins identity and returns early; same rule applies.
func TestSidecarStillHonoursContextLength(t *testing.T) {
	rec := Classify(ClassifyInput{
		Filename:      "SomeModel-Q4_K_M.gguf",
		SidecarFile:   "SomeModel-Q4_K_M.mistral.jinja",
		ContextLength: 4096,
	})
	if rec.ChatTemplateFile == "" {
		t.Fatal("sidecar was not applied")
	}
	if rec.MaxCtx != 4096 {
		t.Errorf("maxCtx = %d, want 4096", rec.MaxCtx)
	}
}

// Absent metadata must leave the placeholder alone rather than zero it.
func TestMissingContextLengthKeepsPlaceholder(t *testing.T) {
	rec := Classify(ClassifyInput{Filename: "Meta-Llama-3.1-8B-Instruct.gguf"})
	if rec.MaxCtx != 131072 {
		t.Errorf("maxCtx = %d, want the 131072 placeholder", rec.MaxCtx)
	}
}

// Nothing may advertise more than the cap, however large the header claims.
func TestContextLengthIsCapped(t *testing.T) {
	rec := Classify(ClassifyInput{Filename: "Meta-Llama-3.1-8B.gguf", ContextLength: 1 << 24})
	if rec.MaxCtx != MaxCtxCap {
		t.Errorf("maxCtx = %d, want the %d cap", rec.MaxCtx, MaxCtxCap)
	}
}

// Every family the classifier emits must be a key chat.html can look up.
//
// chat.html indexes its stop-string table by family, exact match, and says so:
// a miss returns {} and the model's turn markers get rendered to the user as
// content. Architecture-derived families like "qwen2" and "phi3" missed the
// "qwen" and "phi" keys every time.
func TestFamilyIsAlwaysAKnownKey(t *testing.T) {
	// The keys chat.html's STOP table defines, plus the families it documents
	// as deliberately having no extra stop strings.
	known := map[string]bool{
		"cohere": true, "gemma": true, "glm": true, "llama": true,
		"mistral": true, "moonshot": true, "phi": true, "qwen": true,
		"tulu": true,
		// No stop strings by design, but still valid families.
		"custom": true, "deepseek": true, "granite": true, "harmony": true,
	}

	// Architectures a GGUF header or /props can realistically report, plus the
	// values archFromName synthesises from filenames.
	arches := []string{
		"qwen2", "qwen3", "qwen3moe", "Qwen2ForCausalLM",
		"phi3", "phi2", "llama", "llama4", "gemma2", "gemma3",
		"glm4", "chatglm", "cohere", "command-r", "granite",
		"deepseek2", "deepseek", "mistral", "mixtral",
	}
	for _, arch := range arches {
		t.Run(arch, func(t *testing.T) {
			for _, tmpl := range []string{"", "{% for m in messages %}<|im_start|>{% endfor %}"} {
				rec := Classify(ClassifyInput{
					Filename:     "Some-Model-Q4_K_M.gguf",
					Architecture: strings.ToLower(arch),
					ChatTemplate: tmpl,
				})
				if !known[rec.Family] {
					t.Errorf("arch %q (template %q) produced family %q, which chat.html cannot look up",
						arch, tmpl, rec.Family)
				}
			}
		})
	}
}

// Unrecognised architectures must pass through rather than be forced into a
// wrong family.
func TestUnknownArchIsNotRewritten(t *testing.T) {
	if got := familyFromArch("someneworg"); got != "someneworg" {
		t.Errorf("familyFromArch rewrote an unknown arch to %q", got)
	}
}

// Multimodal projectors must never appear in the model list.
//
// Vision models ship mmproj-*.gguf next to the weights, so a scan of model_dir
// finds them. llama-server takes a projector via --mmproj alongside a real
// --model; handed one as --model it refuses to load. Offering it in the
// dropdown is offering a choice that can only fail.
func TestProjectorDetection(t *testing.T) {
	cases := []struct {
		name string
		meta *GGUFMeta
		err  error
		want bool
	}{
		{"mmproj-Model-F16.gguf", &GGUFMeta{Architecture: "clip"}, nil, true},
		{"Model-Q4_K_M.gguf", &GGUFMeta{Architecture: "llama"}, nil, false},
		// The header wins: a normal model that happens to be named oddly stays.
		{"mmproj-weird.gguf", &GGUFMeta{Architecture: "qwen2"}, nil, false},
		// ...and a projector with a plain name is still caught by its header.
		{"vision-tower.gguf", &GGUFMeta{Architecture: "clip"}, nil, true},
		// Unreadable header: fall back to the naming convention.
		{"mmproj-Model-F16.gguf", nil, errUnreadable, true},
		{"Model-Q4_K_M.gguf", nil, errUnreadable, false},
	}
	for _, tc := range cases {
		if got := isProjector(tc.name, tc.meta, tc.err); got != tc.want {
			t.Errorf("isProjector(%q, %+v) = %v, want %v", tc.name, tc.meta, got, tc.want)
		}
	}
}

var errUnreadable = errors.New("unreadable")
