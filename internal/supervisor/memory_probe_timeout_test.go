package supervisor

import (
	"testing"
	"time"
)

// macOS checks a program the first time it runs; for this engine that alone
// was measured at 13.7 s, longer than the ten seconds every other platform
// gets. The probe must outlast it there and stay short everywhere else.
func TestMemoryProbeWaitsOutTheMacFirstRun(t *testing.T) {
	if got := memoryProbeTimeout("darwin"); got < 30*time.Second {
		t.Errorf("macOS probe timeout = %s, too short for a first run", got)
	}
	for _, goos := range []string{"linux", "windows"} {
		if got := memoryProbeTimeout(goos); got != 10*time.Second {
			t.Errorf("%s probe timeout = %s, want the original 10s", goos, got)
		}
	}
}
