package models

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// 1.7.9: a split model is offered once, by its first part, and a link whose
// target is gone is not offered at all.
func TestScanDirOffersSplitModelsOnceAndSkipsBrokenLinks(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"Big-00001-of-00003.gguf", "Big-00002-of-00003.gguf", "Big-00003-of-00003.gguf", "Whole.gguf"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink(filepath.Join(dir, "no-such-file.gguf"), filepath.Join(dir, "Dangling.gguf")); err != nil {
			t.Fatal(err)
		}
	}
	var got []string
	for _, r := range ScanDir(dir) {
		got = append(got, r.File)
	}
	if strings.Join(got, ",") != "Big-00001-of-00003.gguf,Whole.gguf" {
		t.Errorf("ScanDir offered %v", got)
	}
}

func TestSplitPart(t *testing.T) {
	p, part, total, ok := SplitPart("Qwen3-235B-Q4_K_M-00002-of-00004.gguf")
	if !ok || p != "Qwen3-235B-Q4_K_M" || part != 2 || total != 4 {
		t.Errorf("got %q %d %d %v", p, part, total, ok)
	}
	if SplitName(p, 1, 4) != "Qwen3-235B-Q4_K_M-00001-of-00004.gguf" {
		t.Error("SplitName does not round-trip")
	}
	for _, n := range []string{"Model.gguf", "Model-00005-of-00004.gguf", "Model-1-of-2.gguf"} {
		if _, _, _, ok := SplitPart(n); ok {
			t.Errorf("%s is not a split part", n)
		}
	}
}
