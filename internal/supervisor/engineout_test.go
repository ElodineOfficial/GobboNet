package supervisor

import (
	"bytes"
	"strings"
	"testing"
)

/*
The engine's output reaching the screen, and what is read out of it on the way.

The defect these pin is not a crash; it is silence. llama.cpp's output went to a
log file and a 64 KB memory ring, so "loading" was a window that printed nothing
for up to a minute, and whether the model reached the GPU -- the first question
anyone asks when it runs slowly -- could not be answered from the terminal at
all. So what is asserted here is mostly that things ARRIVE.
*/

func TestPrefixWriterEmitsWholeLines(t *testing.T) {
	var out bytes.Buffer
	w := newPrefixWriter(&out, " [llama] ", false)

	if _, err := w.Write([]byte("first line\nsecond line\n")); err != nil {
		t.Fatal(err)
	}
	want := " [llama] first line\n [llama] second line\n"
	if out.String() != want {
		t.Errorf("got %q, want %q", out.String(), want)
	}
}

// llama.cpp writes progress in fragments. A prefix stamped per Write() would
// land mid-sentence, which is worse than no output because it reads as
// corruption.
func TestPrefixWriterHoldsPartialLines(t *testing.T) {
	var out bytes.Buffer
	w := newPrefixWriter(&out, " [llama] ", false)

	w.Write([]byte("load_tensors: offl"))
	if out.Len() != 0 {
		t.Fatalf("a partial line was emitted early: %q", out.String())
	}
	w.Write([]byte("oading 34 layers to GPU\n"))
	if got := out.String(); got != " [llama] load_tensors: offloading 34 layers to GPU\n" {
		t.Errorf("the reassembled line is wrong: %q", got)
	}
}

// The last thing a dying engine prints is usually the reason, and it often
// arrives with no trailing newline.
func TestPrefixWriterFlushesTheLastPartialLine(t *testing.T) {
	var out bytes.Buffer
	w := newPrefixWriter(&out, " [llama] ", false)

	w.Write([]byte("error: unable to load model"))
	if out.Len() != 0 {
		t.Fatal("emitted before flush")
	}
	w.Flush()
	if !strings.Contains(out.String(), "unable to load model") {
		t.Errorf("the final line was swallowed: %q", out.String())
	}
	// Flushing twice must not repeat it.
	before := out.String()
	w.Flush()
	if out.String() != before {
		t.Errorf("a second flush repeated output: %q", out.String())
	}
}

func TestPrefixWriterNeverReportsAShortWrite(t *testing.T) {
	// io.Copy treats a short write as an error, and exec's pipe plumbing uses
	// it — so a held-back partial line must still be reported as consumed.
	var out bytes.Buffer
	w := newPrefixWriter(&out, "x", false)
	p := []byte("no newline here")
	n, err := w.Write(p)
	if err != nil || n != len(p) {
		t.Errorf("Write = %d, %v; want %d, nil", n, err, len(p))
	}
}

func TestPrefixWriterSkipsBlankLines(t *testing.T) {
	var out bytes.Buffer
	w := newPrefixWriter(&out, " [llama] ", false)
	w.Write([]byte("a\n\n   \nb\n"))
	if got := out.String(); got != " [llama] a\n [llama] b\n" {
		t.Errorf("blank lines were not collapsed: %q", got)
	}
}

func TestEngineWatchConfirmsGPUFromRealWording(t *testing.T) {
	// Each of these is wording llama.cpp has actually used. Any one is enough,
	// because these are its internal log strings rather than an interface it
	// owes anyone, and it has moved them before (issue #33).
	for _, line := range []string{
		"load_tensors: offloaded 35/35 layers to GPU\n",
		"load_tensors: offloading 34 repeating layers to GPU\n",
		"llama_kv_cache_unified:    Vulkan0 KV buffer size =   896.00 MiB\n",
		"llama_kv_cache_unified:      CUDA0 KV buffer size =   896.00 MiB\n",
		"ggml_metal_init: Metal0 found\n",
		"ROCm0 buffer size = 100 MiB\n",
		"SYCL0 buffer size = 100 MiB\n",
	} {
		w := newEngineWatch()
		w.Write([]byte(line))
		if !w.GPUConfirmed() {
			t.Errorf("did not recognise %q as GPU offload", strings.TrimSpace(line))
		}
	}
}

func TestEngineWatchDoesNotInventAGPU(t *testing.T) {
	w := newEngineWatch()
	w.Write([]byte("llama_model_loader: loaded meta data with 30 key-value pairs\n"))
	w.Write([]byte("system_info: n_threads = 8\n"))
	if w.GPUConfirmed() {
		t.Error("confirmed a GPU from output that says nothing about one")
	}
	if !w.SawOutput() {
		t.Error("output arrived but SawOutput says otherwise")
	}
}

// A marker split across two writes is the obvious way for a stream scanner to
// miss something, and llama.cpp's output arrives in whatever chunks the pipe
// hands over.
func TestEngineWatchCatchesAMarkerSplitAcrossWrites(t *testing.T) {
	w := newEngineWatch()
	w.Write([]byte("load_tensors: offlo"))
	w.Write([]byte("aded 35/35 layers to GPU\n"))
	if !w.GPUConfirmed() {
		t.Error("a marker split across two writes was missed")
	}
}

func TestEngineWatchSpotsVRAMPressure(t *testing.T) {
	for _, line := range []string{
		"ggml_vulkan: cannot meet free memory requirement\n",
		"llama_model_load: failed to fit the model in VRAM\n",
	} {
		w := newEngineWatch()
		w.Write([]byte(line))
		if !w.VRAMPressure() {
			t.Errorf("did not spot VRAM pressure in %q", strings.TrimSpace(line))
		}
	}
	w := newEngineWatch()
	w.Write([]byte("load_tensors: offloaded 35/35 layers to GPU\n"))
	if w.VRAMPressure() {
		t.Error("reported VRAM pressure on a clean load")
	}
}

func TestEngineWatchResetClearsEverything(t *testing.T) {
	w := newEngineWatch()
	w.Write([]byte("offloaded 35/35 layers to GPU\ncannot meet free memory\n"))
	if !w.GPUConfirmed() || !w.VRAMPressure() || !w.SawOutput() {
		t.Fatal("setup failed")
	}
	w.Reset()
	if w.GPUConfirmed() || w.VRAMPressure() || w.SawOutput() {
		t.Error("Reset left state behind; a swap would inherit the previous model's verdict")
	}
}

func TestSawOutputIsFalseBeforeAnythingArrives(t *testing.T) {
	// "not confirmed" and "never heard from it" need different things said
	// about them, so they must be distinguishable.
	if newEngineWatch().SawOutput() {
		t.Error("SawOutput is true before any output")
	}
}
