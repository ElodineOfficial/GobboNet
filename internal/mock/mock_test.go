package mock

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleStoryMD = `---
id: test-story-01
name: Test Story 01
description: Verifies basic story parsing
author: test-suite
timeout: 30s
---

# Scenario: Verify zero-build invariant

## Step 1: User prompt
Explain the zero-build policy in GobboNet.
- TextAssertion: zero-build
- VisualAssertion: Chat bubble rendered
- VisionJudge: Screen displays chat message without layout distortion

## Step 2: Follow up
Can I use webpack?
- TextAssertion: no build step
`

func TestParseStoryMarkdown(t *testing.T) {
	story, err := ParseStoryMarkdown(sampleStoryMD, "stories/test-story-01.story.md")
	if err != nil {
		t.Fatalf("ParseStoryMarkdown failed: %v", err)
	}

	if story.ID != "test-story-01" {
		t.Errorf("expected ID 'test-story-01', got %q", story.ID)
	}
	if story.Name != "Test Story 01" {
		t.Errorf("expected Name 'Test Story 01', got %q", story.Name)
	}
	if len(story.Steps) != 2 {
		t.Fatalf("expected 2 steps, got %d", len(story.Steps))
	}

	step1 := story.Steps[0]
	if !strings.Contains(step1.Prompt, "zero-build policy") {
		t.Errorf("unexpected step 1 prompt: %q", step1.Prompt)
	}
	if len(step1.ExpectedText) != 1 || step1.ExpectedText[0] != "zero-build" {
		t.Errorf("unexpected step 1 ExpectedText: %v", step1.ExpectedText)
	}
	if len(step1.VisualAssertions) != 1 || step1.VisualAssertions[0] != "Chat bubble rendered" {
		t.Errorf("unexpected step 1 VisualAssertions: %v", step1.VisualAssertions)
	}
	if !strings.Contains(step1.VisionPrompt, "layout distortion") {
		t.Errorf("unexpected step 1 VisionPrompt: %q", step1.VisionPrompt)
	}
}

func TestEngineReplayAndHTTP(t *testing.T) {
	tempDir := t.TempDir()

	// Mock upstream LLM
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{
			"choices": []map[string]any{
				{
					"message": map[string]string{
						"content": "GobboNet enforces a strict zero-build policy with no build step required.",
					},
				},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer mockLLM.Close()

	// Write story file to disk
	storyFile := filepath.Join(tempDir, "test-story.story.md")
	if err := os.WriteFile(storyFile, []byte(sampleStoryMD), 0o644); err != nil {
		t.Fatalf("write story file failed: %v", err)
	}

	engine := NewEngine(tempDir, mockLLM.URL, "")

	// Discover
	stories, err := engine.DiscoverStories()
	if err != nil {
		t.Fatalf("DiscoverStories failed: %v", err)
	}
	if len(stories) != 1 {
		t.Fatalf("expected 1 story, got %d", len(stories))
	}

	// Run story
	res, err := engine.RunStory(context.Background(), stories[0])
	if err != nil {
		t.Fatalf("RunStory failed: %v", err)
	}
	if res.Status != "passed" {
		t.Errorf("expected status 'passed', got %q (errors: %v)", res.Status, res.StepResults[0].Errors)
	}

	// Test GET /mock/stories
	req := httptest.NewRequest(http.MethodGet, "/mock/stories", nil)
	rec := httptest.NewRecorder()
	engine.Handle(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /mock/stories code: %d", rec.Code)
	}

	// Test POST /mock/replay
	body := `{"story_id": "test-story-01"}`
	req = httptest.NewRequest(http.MethodPost, "/mock/replay", strings.NewReader(body))
	rec = httptest.NewRecorder()
	engine.Handle(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /mock/replay code: %d", rec.Code)
	}
}

func TestDatasetAndReport(t *testing.T) {
	tempDir := t.TempDir()
	datasetFile := filepath.Join(tempDir, "dataset.jsonl")

	rec := TrajectoryRecord{
		ID:        "rec-001",
		StoryID:   "test-story-01",
		StepIndex: 1,
		Prompt:    "Explain zero-build",
		Chosen:    "GobboNet has no build step.",
		Rejected:  "Use webpack.",
		Images:    []string{"screenshots/step1.png"},
	}

	if err := AppendDatasetRecord(datasetFile, rec); err != nil {
		t.Fatalf("AppendDatasetRecord failed: %v", err)
	}

	content, err := os.ReadFile(datasetFile)
	if err != nil {
		t.Fatalf("read dataset failed: %v", err)
	}
	if !strings.Contains(string(content), "rec-001") || !strings.Contains(string(content), "screenshots/step1.png") {
		t.Errorf("unexpected dataset content: %s", string(content))
	}

	story, _ := ParseStoryMarkdown(sampleStoryMD, "test.md")
	runRes := &RunResult{
		RunID:   "run-001",
		StoryID: story.ID,
		Status:  "passed",
		StepResults: []StepResult{
			{StepIndex: 1, Passed: true, Output: "No build step required.", ImageProof: "screenshots/step1.png"},
		},
	}
	report := GenerateMarkdownReport(runRes, *story)
	if !strings.Contains(report, "Story Verification Report") || !strings.Contains(report, "screenshots/step1.png") {
		t.Errorf("unexpected report markdown:\n%s", report)
	}
}
