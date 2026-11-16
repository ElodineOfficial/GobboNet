package supervisor

import "testing"

func TestLastRunRecognisesCurrentLlamaServerListeningLine(t *testing.T) {
	log := logRunMarker + "model.gguf at now ===\n" +
		"0.01 I srv llama_server: model loaded\n" +
		"0.01 I srv llama_server: listening on http://127.0.0.1:11437\n"
	run := LastRunInLog(log)
	if !run.Loaded || run.Failure != nil {
		t.Fatalf("LastRunInLog = %+v", run)
	}
}
