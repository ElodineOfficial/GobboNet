package models

import (
	"errors"
	"strings"
	"testing"
)

// Issue: Supervisor.Swap joined whatever name it was given onto the models
// folder, so "../elsewhere/x.gguf" was started from outside it (1.8.0 plan,
// item #4). CheckFileName is the one rule for "a model in the models folder".
func TestCheckFileName(t *testing.T) {
	good := []string{
		"Llama-3.2-3B-Instruct-Q8_0.gguf",
		"model.GGUF",                                      // Windows does not care about case, nor do we
		"Qwen_Qwen3.6-35B-A3B-Q4_K_M-00001-of-00003.gguf", // a split model's first part
		"name with spaces.gguf",
		"..hidden-ish.gguf", // dots inside a name are a name, not a path
		"x.gguf",
	}
	for _, name := range good {
		if err := CheckFileName(name); err != nil {
			t.Errorf("CheckFileName(%q) = %v, want nil", name, err)
		}
	}

	bad := []string{
		"",
		".", "..",
		".gguf",     // nothing before the extension
		"../x.gguf", // up and out
		"../../etc/x.gguf",
		"sub/x.gguf", // into a subfolder
		`sub\x.gguf`, // the same on Windows, checked everywhere
		`..\x.gguf`,
		"/abs/x.gguf",
		`C:\models\x.gguf`,
		"C:x.gguf",       // drive-relative on Windows
		"x.gguf:stream",  // an NTFS alternate data stream
		"x.gguf\x00.txt", // NUL
		"x\n.gguf",       // control character
		"x.txt",          // not a model
		"x.gguf.exe",
		"x.gguf ", // Windows trims the space and opens x.gguf
		"x.gguf.", // ... and the dot
		strings.Repeat("a", 252) + ".gguf",
	}
	for _, name := range bad {
		err := CheckFileName(name)
		if err == nil {
			t.Errorf("CheckFileName(%q) = nil, want an error", name)
			continue
		}
		if !errors.Is(err, ErrBadFileName) {
			t.Errorf("CheckFileName(%q) = %v, which does not wrap ErrBadFileName", name, err)
		}
	}
}
