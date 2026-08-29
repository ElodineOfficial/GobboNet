package mock

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// TrajectoryRecord represents a multimodal OpenRLHF / SFT / DPO training pair.
type TrajectoryRecord struct {
	ID                 string         `json:"id"`
	StoryID            string         `json:"story_id"`
	StepIndex          int            `json:"step"`
	SystemPrompt       string         `json:"system,omitempty"`
	Prompt             string         `json:"prompt"`
	Chosen             string         `json:"chosen"`
	Rejected           string         `json:"rejected,omitempty"`
	Images             []string       `json:"images,omitempty"`
	VisionVerification map[string]any `json:"vision_verification,omitempty"`
	Provenance         map[string]any `json:"provenance"`
}

var datasetMu sync.Mutex

// AppendDatasetRecord writes a trajectory record to a JSONL dataset file.
func AppendDatasetRecord(datasetPath string, rec TrajectoryRecord) error {
	datasetMu.Lock()
	defer datasetMu.Unlock()

	if err := os.MkdirAll(filepath.Dir(datasetPath), 0o755); err != nil {
		return fmt.Errorf("create dataset directory: %w", err)
	}

	f, err := os.OpenFile(datasetPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open dataset file: %w", err)
	}
	defer f.Close()

	if rec.Provenance == nil {
		rec.Provenance = make(map[string]any)
	}
	if _, ok := rec.Provenance["timestamp"]; !ok {
		rec.Provenance["timestamp"] = time.Now().Unix()
	}

	data, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("marshal trajectory record: %w", err)
	}

	if _, err := f.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("write trajectory line: %w", err)
	}

	return nil
}
