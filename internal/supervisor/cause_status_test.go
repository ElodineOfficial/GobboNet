//go:build !windows

package supervisor

import (
	"errors"
	"strings"
	"testing"
)

// A failed load publishes its cause through Status(), so /swap-status, the
// landing page, the chat error and doctor can all say it (1.8.0, #67).
func TestAFailedLoadPublishesItsCause(t *testing.T) {
	script := "#!/bin/sh\n" +
		"echo 'ggml_vulkan: Device memory allocation of size 13421772800 failed.' >&2\n" +
		"echo 'alloc_tensor_range: failed to allocate Vulkan0 buffer of size 13421772800' >&2\n" +
		"echo 'llama_model_load_from_file_impl: failed to load model' >&2\n" +
		"echo 'main: exiting due to model loading error' >&2\n" +
		"exit 1\n"
	sup := newTestSupervisor(t, script)
	err := sup.Boot("model.gguf")
	if err == nil {
		t.Fatal("Boot succeeded with an engine that cannot load")
	}
	var le *LoadError
	if !errors.As(err, &le) || le.Cause != CauseOutOfMemory {
		t.Fatalf("Boot error = %v (%T), want a LoadError with cause out_of_memory", err, err)
	}
	st := sup.Status()
	if st.Phase != PhaseError || st.Cause != CauseOutOfMemory {
		t.Fatalf("status = %+v, want error phase with cause out_of_memory", st)
	}
	if !strings.Contains(st.Message, "failed to allocate Vulkan0 buffer") || strings.Contains(st.Message, "exiting due to") {
		t.Errorf("message = %q, want the allocation line, not the sign-off", st.Message)
	}
	if st.Advice != CauseAdvice(CauseOutOfMemory) || !strings.Contains(st.Advice, "smaller model") {
		t.Errorf("advice = %q", st.Advice)
	}
	if st.Log != "llama-server.log" {
		t.Errorf("log = %q, want the file's name only, never the folder", st.Log)
	}

	// A later success clears all of it.
	sup.setStatus(PhaseReady, "model.gguf", "model.gguf", "Ready", 1)
	if st := sup.Status(); st.Cause != "" || st.Advice != "" || st.Log != "" {
		t.Errorf("a ready status still carries the old failure: %+v", st)
	}
}
