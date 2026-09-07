package atomicfile

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestWriteCreatesAndReplaces(t *testing.T) {
	path := filepath.Join(t.TempDir(), "conf.toml")

	if err := Write(path, []byte("first"), 0o600); err != nil {
		t.Fatalf("create: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "first" {
		t.Errorf("after create: got %q", got)
	}

	if err := Write(path, []byte("second"), 0o600); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "second" {
		t.Errorf("after replace: got %q", got)
	}
}

func TestWriteAppliesPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission bits are not meaningful here")
	}
	path := filepath.Join(t.TempDir(), "secret.toml")
	if err := Write(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// A config holding a password hash must not be world-readable, and
	// CreateTemp's default is only correct by coincidence.
	if got := st.Mode().Perm(); got != 0o600 {
		t.Errorf("mode: got %o, want 600", got)
	}
}

// The bug this package exists for. Every concurrent writer must succeed, and the
// file left behind must be exactly one of the versions written — never a blend,
// never truncated, never missing.
func TestConcurrentWritersDoNotCollide(t *testing.T) {
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(8))

	const writers = 8
	for attempt := 0; attempt < 200; attempt++ {
		dir := t.TempDir()
		path := filepath.Join(dir, "conf.toml")

		bodies := make([][]byte, writers)
		for i := range bodies {
			// Different lengths, so a torn write cannot accidentally look
			// like a whole one.
			bodies[i] = []byte(strings.Repeat(string(rune('a'+i)), 64+i*7))
		}

		start := make(chan struct{})
		errs := make([]error, writers)
		var wg sync.WaitGroup
		for i := 0; i < writers; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				errs[i] = Write(path, bodies[i], 0o600)
			}(i)
		}
		close(start)
		wg.Wait()

		for i, err := range errs {
			if err != nil {
				t.Fatalf("attempt %d, writer %d: %v", attempt, i, err)
			}
		}

		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("attempt %d: reading back: %v", attempt, err)
		}
		matched := false
		for _, b := range bodies {
			if bytes.Equal(got, b) {
				matched = true
				break
			}
		}
		if !matched {
			t.Fatalf("attempt %d: file is not any single writer's content (%d bytes)",
				attempt, len(got))
		}

		// A temp file surviving would mean a failure path forgot to clean up,
		// and would accumulate in a real config directory.
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".tmp") {
				t.Fatalf("attempt %d: leftover temp file %q", attempt, e.Name())
			}
		}
	}
}

// A write that cannot be made must leave the previous contents alone. That is
// the whole promise of write-then-rename.
func TestFailedWriteLeavesOriginalIntact(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "conf.toml")
	if err := Write(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}

	// A directory that cannot be written to is the most portable way to make
	// CreateTemp fail without stubbing the filesystem.
	if runtime.GOOS != "windows" && os.Geteuid() != 0 {
		locked := filepath.Join(dir, "locked")
		if err := os.Mkdir(locked, 0o500); err != nil {
			t.Fatal(err)
		}
		if err := Write(filepath.Join(locked, "x.toml"), []byte("nope"), 0o600); err == nil {
			t.Error("expected a write into a read-only directory to fail")
		}
	}

	if got, _ := os.ReadFile(path); string(got) != "original" {
		t.Errorf("original was disturbed: got %q", got)
	}
}
