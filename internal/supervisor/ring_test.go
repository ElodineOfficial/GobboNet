package supervisor

import (
	"fmt"
	"strings"
	"testing"
)

func wrapErr(err error) error { return fmt.Errorf("%w; cleanup: <nil>", err) }

// Why a model failed to load (1.8.0, #67). Each fixture is the tail of a real
// b10456 failure in llama.cpp's own words, sign-off included: the reason is a
// few lines up, and "main: exiting due to model loading error" is last.

const signOff = "srv    load_model: failed to load model, '/m/x.gguf'\n" +
	"srv   operator(): operator(): cleaning up before exit...\n" +
	"main: exiting due to model loading error\n"

var causeFixtures = []struct {
	name, cause, line, log string
}{
	{"engine too old", CauseEngineTooOld,
		"llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'qwen9moe'",
		"llama_model_loader: - kv   0:                       general.architecture str              = qwen9moe\n" +
			"llama_model_loader: - type  f32:  241 tensors\n" +
			"print_info: file format = GGUF V3 (latest)\n" +
			"llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'qwen9moe'\n" +
			"llama_model_load_from_file_impl: failed to load model\n" +
			"common_init_from_params: failed to load model '/m/x.gguf'\n" + signOff},
	{"incomplete download", CauseIncompleteFile,
		"llama_model_load: error loading model: tensor 'blk.31.ffn_down.weight' data is not within the file bounds, model is corrupted or incomplete",
		"load_tensors: loading model tensors, this can take a while... (mmap = true)\n" +
			"llama_model_load: error loading model: tensor 'blk.31.ffn_down.weight' data is not within the file bounds, model is corrupted or incomplete\n" +
			"llama_model_load_from_file_impl: failed to load model\n" + signOff},
	{"not a GGUF at all", CauseIncompleteFile,
		"gguf_init_from_file_impl: invalid magic characters: '<!DO', expected 'GGUF'",
		"gguf_init_from_file_impl: invalid magic characters: '<!DO', expected 'GGUF'\n" +
			"llama_model_load: error loading model: llama_model_loader: failed to load model from /m/x.gguf\n" +
			"llama_model_load_from_file_impl: failed to load model\n" + signOff},
	{"empty file", CauseIncompleteFile,
		"gguf_init_from_file_impl: failed to read magic",
		"gguf_init_from_file_impl: failed to read magic\n" +
			"llama_model_load: error loading model: llama_model_loader: failed to load model from /m/x.gguf\n" + signOff},
	{"vulkan out of memory", CauseOutOfMemory,
		"llama_model_load: error loading model: unable to allocate Vulkan0 buffer",
		"ggml_vulkan: Device memory allocation of size 13421772800 failed.\n" +
			"ggml_vulkan: Requested buffer size exceeds device memory allocation limit: ErrorOutOfDeviceMemory\n" +
			"alloc_tensor_range: failed to allocate Vulkan0 buffer of size 13421772800\n" +
			"llama_model_load: error loading model: unable to allocate Vulkan0 buffer\n" +
			"llama_model_load_from_file_impl: failed to load model\n" + signOff},
	{"cuda out of memory", CauseOutOfMemory,
		"ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9216.00 MiB on device 0: cudaMalloc failed: out of memory",
		"ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9216.00 MiB on device 0: cudaMalloc failed: out of memory\n" +
			"llama_init_from_model: failed to initialize the context: failed to allocate buffer for kv cache\n" +
			"common_init_from_params: failed to create context with model '/m/x.gguf'\n" + signOff},
	{"file gone", CauseFileNotFound,
		"gguf_init_from_file: failed to open GGUF file '/m/x.gguf'",
		"gguf_init_from_file: failed to open GGUF file '/m/x.gguf'\n" +
			"llama_model_load: error loading model: llama_model_loader: failed to load model from /m/x.gguf\n" + signOff},
}

func TestFindCausePicksTheReasonNotTheSignOff(t *testing.T) {
	for _, f := range causeFixtures {
		cause, line := findCause(f.log)
		if cause != f.cause {
			t.Errorf("%s: cause %q, want %q", f.name, cause, f.cause)
		}
		// For the CUDA case the latest matching line is the KV-cache one; both
		// say out of memory, and the latest is the one closest to the failure.
		if f.name != "cuda out of memory" && line != f.line {
			t.Errorf("%s: line\n  %q\nwant\n  %q", f.name, line, f.line)
		}
		if CauseAdvice(cause) == "" {
			t.Errorf("%s: no plain sentence for %q", f.name, cause)
		}
	}
}

func TestTheSignOffNeverBeatsACause(t *testing.T) {
	for _, f := range causeFixtures {
		r := newRingBuffer(64 * 1024)
		r.Write([]byte(f.log))
		got := r.LastError()
		if strings.Contains(strings.ToLower(got), "exiting due to model loading error") {
			t.Errorf("%s: LastError() = %q, the sign-off", f.name, got)
		}
		fail := r.failure()
		if fail == nil || fail.Cause != f.cause {
			t.Errorf("%s: failure() = %+v, want cause %q", f.name, fail, f.cause)
		}
	}
}

// With no known cause, the generic scan still skips the sign-off and the
// "failed to load model" summary when anything else was said.
func TestTheGenericScanSkipsSummariesWhenItCan(t *testing.T) {
	r := newRingBuffer(4096)
	r.Write([]byte("llama_model_load: error loading model: something new in a later engine\n" +
		"llama_model_load_from_file_impl: failed to load model\n" + signOff))
	if got := r.LastError(); got != "llama_model_load: error loading model: something new in a later engine" {
		t.Errorf("LastError() = %q", got)
	}
	if f := r.failure(); f == nil || f.Cause != "" {
		t.Errorf("an unknown reason is no cause: %+v", f)
	}

	only := newRingBuffer(4096)
	only.Write([]byte("main: exiting due to model loading error\n"))
	if got := only.LastError(); got != "main: exiting due to model loading error" {
		t.Errorf("a sign-off alone is still better than nothing: %q", got)
	}
	empty := newRingBuffer(4096)
	empty.Write([]byte("build: 10456 (abc) with cc\nsystem info: n_threads = 8\n"))
	if got := empty.LastError(); got != "" || empty.failure() != nil {
		t.Errorf("startup chatter is not a reason: %q", got)
	}
}

func TestCauseOfFollowsWrappedErrors(t *testing.T) {
	le := &LoadError{Cause: CauseOutOfMemory, Line: "x"}
	if causeOf(le) != CauseOutOfMemory {
		t.Error("causeOf(LoadError)")
	}
	if causeOf(wrapErr(le)) != CauseOutOfMemory {
		t.Error("causeOf does not see through %w, which load() uses")
	}
	if causeOf(nil) != "" {
		t.Error("causeOf(nil)")
	}
}
