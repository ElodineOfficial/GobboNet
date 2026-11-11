package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 1.8.0 (#13): a ZIP update over 1.7 leaves fileserver.ps1 behind, because
// extracting cannot delete. doctor names it and says it is safe to delete --
// and says nothing at all on an install that has none.
func TestReportLegacyLeftovers(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	reportLegacyLeftovers(&out, dir)
	if out.Len() != 0 {
		t.Fatalf("a clean folder printed %q, want nothing", out.String())
	}

	if err := os.WriteFile(filepath.Join(dir, "fileserver.ps1"), []byte("# 1.7.9\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "fileserver.log"), 0o755); err != nil {
		t.Fatal(err) // a directory of that name is not the log; not reported
	}
	reportLegacyLeftovers(&out, dir)
	got := out.String()
	for _, want := range []string{"LEFTOVERS FROM 1.7", filepath.Join(dir, "fileserver.ps1"), "nothing runs it", "you can", "delete these"} {
		if !strings.Contains(got, want) {
			t.Errorf("report is missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, filepath.Join(dir, "fileserver.log")) {
		t.Errorf("a directory named fileserver.log was reported as the old log:\n%s", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "fileserver.ps1")); err != nil {
		t.Errorf("doctor must not delete anything: %v", err)
	}
	reportLegacyLeftovers(&out, "")
}
