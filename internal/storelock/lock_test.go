package storelock

import (
	"os"
	"os/exec"
	"testing"
)

func TestLockExcludesAnotherProcessAndReleasesOnExit(t *testing.T) {
	if dir := os.Getenv("GOBBONET_TEST_LOCK_DIR"); dir != "" {
		guard, err := Acquire(dir)
		if os.Getenv("GOBBONET_TEST_HOLD_LOCK") != "" {
			if err != nil {
				os.Exit(2)
			}
			_ = guard
			// Simulate abrupt exit: no Close and no deferred cleanup.
			os.Exit(0)
		}
		if err == nil {
			guard.Close()
			os.Exit(3)
		}
		os.Exit(0)
	}
	dir := t.TempDir()
	guard, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestLockExcludesAnotherProcessAndReleasesOnExit$")
	child.Env = append(os.Environ(), "GOBBONET_TEST_LOCK_DIR="+dir)
	if out, err := child.CombinedOutput(); err != nil {
		t.Fatalf("second process was not excluded: %v %s", err, out)
	}
	guard.Close()
	child = exec.Command(os.Args[0], "-test.run=^TestLockExcludesAnotherProcessAndReleasesOnExit$")
	child.Env = append(os.Environ(), "GOBBONET_TEST_LOCK_DIR="+dir, "GOBBONET_TEST_HOLD_LOCK=1")
	if out, err := child.CombinedOutput(); err != nil {
		t.Fatalf("lock after close: %v %s", err, out)
	}
	guard, err = Acquire(dir)
	if err != nil {
		t.Fatalf("crashed process stranded lock: %v", err)
	}
	guard.Close()
}
