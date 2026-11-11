package supervisor

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Swap used to join whatever name it was given onto the models folder and
// start the result, so "../elsewhere/x.gguf" ran a model from outside it
// (1.8.0 plan, item #4). The name now has to be a plain .gguf name.
//
// Every refusal must happen before anything is dispatched: the phase stays
// idle, and nothing names the models folder's path.

func swapFixture(t *testing.T) (s *Supervisor, root, modelDir string) {
	t.Helper()
	root = t.TempDir()
	modelDir = filepath.Join(root, "models")
	for _, d := range []string{modelDir, filepath.Join(modelDir, "sub")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{
		filepath.Join(root, "outside.gguf"),      // the target of every escape
		filepath.Join(modelDir, "real.gguf"),     // a model that is really there
		filepath.Join(modelDir, "sub", "x.gguf"), // a GGUF one folder down: not listed, not swappable
		filepath.Join(modelDir, "notes.txt"),     // in the folder, but not a model
	} {
		if err := os.WriteFile(f, []byte("GGUF"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s, err := New(Options{ModelDir: modelDir, LLMURL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	return s, root, modelDir
}

func TestSwapRefusesAnythingButABareGGUFName(t *testing.T) {
	s, root, _ := swapFixture(t)
	for _, name := range []string{
		"../outside.gguf",
		"sub/../../outside.gguf",
		`..\outside.gguf`,
		"sub/x.gguf",
		`sub\x.gguf`,
		filepath.Join(root, "outside.gguf"), // an absolute path
		"notes.txt",
		"real.gguf:stream",
		".gguf",
		"",
	} {
		err := s.Swap(name)
		if err == nil {
			t.Errorf("Swap(%q) was accepted; it must be refused before anything starts", name)
			continue
		}
		if errors.Is(err, ErrSwapInFlight) {
			t.Errorf("Swap(%q) got as far as the in-flight check", name)
		}
		if strings.Contains(err.Error(), root) {
			t.Errorf("Swap(%q) error names a path on this PC: %v", name, err)
		}
		if st := s.Status(); st.Phase != PhaseIdle {
			t.Errorf("after Swap(%q) the phase is %q, want idle: something was dispatched", name, st.Phase)
		}
	}
}

func TestSwapNotFoundDoesNotNameTheModelsFolder(t *testing.T) {
	s, root, _ := swapFixture(t)
	err := s.Swap("missing.gguf")
	if err == nil || !strings.Contains(err.Error(), "not found in the models folder") {
		t.Fatalf("Swap(missing.gguf) = %v, want not found in the models folder", err)
	}
	if strings.Contains(err.Error(), root) {
		t.Errorf("the error tells the asking device where models live: %v", err)
	}
}

// What must still work. With a swap marked in flight, Swap answers
// ErrSwapInFlight only after the name and the file have passed, so nothing is
// started and the test proves the checks let it through.
func TestSwapStillAcceptsModelsInTheFolder(t *testing.T) {
	s, root, modelDir := swapFixture(t)
	s.swapping = true

	if err := s.Swap("real.gguf"); !errors.Is(err, ErrSwapInFlight) {
		t.Errorf("Swap(real.gguf) = %v, want it past the checks (ErrSwapInFlight)", err)
	}
	if err := s.Swap("REAL.GGUF"); runtime.GOOS == "windows" && !errors.Is(err, ErrSwapInFlight) {
		t.Errorf("Swap(REAL.GGUF) on Windows = %v, want it past the checks", err)
	}

	// USE IT links a found model into the folder. The link's target is
	// elsewhere, and that is fine: the NAME is in the models folder.
	link := filepath.Join(modelDir, "linked.gguf")
	if err := os.Symlink(filepath.Join(root, "outside.gguf"), link); err != nil {
		t.Skipf("cannot make a symlink here: %v", err)
	}
	if err := s.Swap("linked.gguf"); !errors.Is(err, ErrSwapInFlight) {
		t.Errorf("Swap(linked.gguf) = %v, want a link in the folder accepted", err)
	}
}
