package config

import "testing"

func TestAutomaticPlacementAndExplicitLayerSettings(t *testing.T) {
	if Default().GPULayers != -1 || Default().GPUReserveMiB != 1024 {
		t.Fatal("missing automatic placement defaults")
	}
	for _, layers := range []int{-1, 0, 20, 99} {
		p := Perf{GPULayers: layers, GPULayersSet: true}
		if err := p.Validate(); err != nil {
			t.Fatal(err)
		}
		_, got, _ := p.Apply(32768, 17, "f16")
		if got != layers {
			t.Fatalf("explicit setting %d changed to %d", layers, got)
		}
	}
	p := Perf{GPULayers: -2, GPULayersSet: true}
	if p.Validate() == nil {
		t.Fatal("invalid negative GPU count accepted")
	}
}
