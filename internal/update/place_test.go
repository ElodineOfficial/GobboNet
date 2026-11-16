package update

import (
	"strings"
	"testing"
)

func TestDarwinUpdateIsExplicitlyManual(t *testing.T) {
	p := locate("darwin", "arm64", "/Applications/GobboNet.app/Contents/MacOS/gobbonet", "", "", func(string) bool { return true })
	if p.Kind != KindUnsupported || p.CanInstall() || p.Target != "" {
		t.Fatalf("Darwin place = %+v", p)
	}
	if !strings.Contains(p.Reason, "macOS") || !strings.Contains(p.Reason, "GobboNet.app") {
		t.Fatalf("Darwin reason = %q", p.Reason)
	}
}
