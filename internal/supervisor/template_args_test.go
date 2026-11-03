package supervisor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/models"
)

// argValue returns the value after flag, or "" when flag is absent.
func argValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func hasArg(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func newArgsSupervisor(t *testing.T, opts Options) *Supervisor {
	t.Helper()
	if opts.LLMURL == "" {
		opts.LLMURL = "http://127.0.0.1:1"
	}
	s, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// The 1.7.9 Tekken bug. The pinned engine has Jinja ON by default, and with
// Jinja on llama-server reads --chat-template as Jinja *source*: the name
// "mistral-v7-tekken" rendered as that literal string for every request, so
// the model only ever saw the word "tekken". A built-in name must therefore
// never reach the engine without --no-jinja, whichever path chose it.
func TestBuiltinTemplateNameAlwaysTravelsWithNoJinja(t *testing.T) {
	cases := []struct {
		name string
		rec  models.Record
		opts Options
	}{
		{"classifier: mistral-small fallback", models.Record{UseJinja: 0, ChatTemplate: "mistral-v7-tekken"}, Options{}},
		{"classifier: mistral-nemo", models.Record{UseJinja: 0, ChatTemplate: "mistral-v3-tekken"}, Options{}},
		{"classifier: glm-4-9b", models.Record{UseJinja: 0, ChatTemplate: "chatglm4"}, Options{}},
		// A record that asks for Jinja AND a name is contradictory; the name
		// wins, because Jinja-plus-name is exactly the literal-string bug.
		{"contradictory record", models.Record{UseJinja: 1, ChatTemplate: "mistral-v7-tekken"}, Options{}},
		{"config override chat_template_name", models.Record{UseJinja: 1}, Options{ChatTemplateName: "mistral-v7-tekken"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			args := newArgsSupervisor(t, c.opts).BuildArgs(c.rec, "model.gguf")
			if argValue(args, "--chat-template") == "" {
				t.Fatalf("expected a --chat-template name, got %v", args)
			}
			if !hasArg(args, "--no-jinja") {
				t.Errorf("built-in name sent without --no-jinja: %v", args)
			}
			if hasArg(args, "--jinja") {
				t.Errorf("built-in name sent WITH --jinja (renders the name as literal text): %v", args)
			}
		})
	}
}

// The other half: models that rely on their embedded Jinja template keep it.
func TestEmbeddedTemplateKeepsJinja(t *testing.T) {
	args := newArgsSupervisor(t, Options{}).BuildArgs(models.Record{UseJinja: 1}, "model.gguf")
	if !hasArg(args, "--jinja") || hasArg(args, "--no-jinja") {
		t.Errorf("embedded-template model should get --jinja only: %v", args)
	}
	if argValue(args, "--chat-template") != "" {
		t.Errorf("no template name expected: %v", args)
	}
}

// A sidecar .jinja is a file, read with Jinja on, and must not be paired with
// --no-jinja (which would make llama.cpp reject or misread it).
func TestSidecarTemplateFileKeepsJinja(t *testing.T) {
	dir := t.TempDir()
	tmpl := filepath.Join(dir, "x.jinja")
	body := "{% for m in messages %}[INST]{{ m.content }}[/INST]{% endfor %}"
	if err := os.WriteFile(tmpl, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	s := newArgsSupervisor(t, Options{ModelDir: dir})
	args := s.BuildArgs(models.Record{UseJinja: 0, ChatTemplate: "mistral-v7-tekken", ChatTemplateFile: "models/x.jinja"}, "model.gguf")
	if argValue(args, "--chat-template-file") != tmpl {
		t.Fatalf("sidecar not passed as a file: %v", args)
	}
	if !hasArg(args, "--jinja") || hasArg(args, "--no-jinja") || argValue(args, "--chat-template") != "" {
		t.Errorf("sidecar should run with --jinja and no name: %v", args)
	}
}

// Jinja's state is always stated. Leaving it to the engine default is what
// broke when the default flipped.
func TestJinjaStateIsAlwaysExplicit(t *testing.T) {
	for _, rec := range []models.Record{{UseJinja: 0}, {UseJinja: 1}, {UseJinja: 0, ChatTemplate: "chatml"}} {
		args := strings.Join(newArgsSupervisor(t, Options{}).BuildArgs(rec, "m.gguf"), " ")
		if !strings.Contains(args, "--jinja") && !strings.Contains(args, "--no-jinja") {
			t.Errorf("record %+v: neither --jinja nor --no-jinja in %q", rec, args)
		}
	}
}
