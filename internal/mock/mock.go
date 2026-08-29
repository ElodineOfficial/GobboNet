// Package mock implements user story parsing, mocking, replay, and stress-testing.
package mock

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jmccardle/gobbonet/internal/httpx"
)

// StoryStep represents a single turn or action within a user story.
type StoryStep struct {
	StepIndex        int      `json:"step_index"`
	Role             string   `json:"role"` // "user" or "assistant"
	Prompt           string   `json:"prompt"`
	ExpectedText     []string `json:"expected_text,omitempty"`
	VisualAssertions []string `json:"visual_assertions,omitempty"`
	VisionPrompt     string   `json:"vision_prompt,omitempty"`
}

// Story represents a full user story workflow definition.
type Story struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Author      string      `json:"author"`
	Timeout     string      `json:"timeout"`
	Steps       []StoryStep `json:"steps"`
	RawMarkdown string      `json:"raw_markdown,omitempty"`
	Path        string      `json:"path"`
}

// StepResult represents the execution result of a single step.
type StepResult struct {
	StepIndex int           `json:"step_index"`
	Passed    bool          `json:"passed"`
	Output    string        `json:"output"`
	Duration  time.Duration `json:"duration"`
	Errors    []string      `json:"errors,omitempty"`
	ImageProof string       `json:"image_proof,omitempty"`
}

// RunResult represents the outcome of a story replay or stress test.
type RunResult struct {
	RunID       string        `json:"run_id"`
	StoryID     string        `json:"story_id"`
	Status      string        `json:"status"` // "running", "passed", "failed"
	StartedAt   time.Time     `json:"started_at"`
	CompletedAt time.Time     `json:"completed_at,omitempty"`
	Duration    time.Duration `json:"duration"`
	StepResults []StepResult  `json:"step_results"`
	Logs        []string      `json:"logs"`
}

// Engine manages user stories, replay execution, and stress testing.
type Engine struct {
	mu         sync.RWMutex
	storiesDir string
	llmURL     string
	apiKey     string
	runs       map[string]*RunResult
}

// NewEngine creates a new Mock Engine.
func NewEngine(storiesDir, llmURL, apiKey string) *Engine {
	return &Engine{
		storiesDir: storiesDir,
		llmURL:     llmURL,
		apiKey:     apiKey,
		runs:       make(map[string]*RunResult),
	}
}

// ParseStoryMarkdown parses a .story.md or markdown story file.
func ParseStoryMarkdown(raw, path string) (*Story, error) {
	story := &Story{
		Steps:       []StoryStep{},
		RawMarkdown: raw,
		Path:        path,
	}

	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	if len(lines) == 0 {
		return nil, errors.New("empty story file")
	}

	bodyStartIndex := 0
	if strings.TrimSpace(lines[0]) == "---" {
		endIndex := -1
		for i := 1; i < len(lines); i++ {
			if strings.TrimSpace(lines[i]) == "---" {
				endIndex = i
				break
			}
		}
		if endIndex != -1 {
			parseFrontmatter(lines[1:endIndex], story)
			bodyStartIndex = endIndex + 1
		}
	}

	if story.ID == "" && path != "" {
		base := filepath.Base(path)
		story.ID = strings.TrimSuffix(strings.TrimSuffix(base, ".story.md"), ".md")
	}
	if story.Name == "" {
		story.Name = story.ID
	}

	// Parse body steps
	if bodyStartIndex < len(lines) {
		body := strings.Join(lines[bodyStartIndex:], "\n")
		parseStorySteps(body, story)
	}

	return story, nil
}

func parseFrontmatter(lines []string, s *Story) {
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.Contains(trimmed, ":") {
			parts := strings.SplitN(trimmed, ":", 2)
			k := strings.ToLower(strings.TrimSpace(parts[0]))
			v := strings.Trim(strings.TrimSpace(parts[1]), "\"'")
			switch k {
			case "id":
				s.ID = v
			case "name":
				s.Name = v
			case "description":
				s.Description = v
			case "author":
				s.Author = v
			case "timeout":
				s.Timeout = v
			}
		}
	}
}

var stepHeaderRegex = regexp.MustCompile(`(?i)^(?:##?\s*(?:Step\s*\d+|When|Then|Given|User|Assistant)[:\s]*(.*))`)

func parseStorySteps(body string, s *Story) {
	lines := strings.Split(body, "\n")
	var currentPrompt strings.Builder
	var currentExpected []string
	var currentVisual []string
	var currentVisionPrompt string
	stepIndex := 0

	flushStep := func() {
		promptStr := strings.TrimSpace(currentPrompt.String())
		if promptStr != "" || len(currentExpected) > 0 || len(currentVisual) > 0 {
			stepIndex++
			s.Steps = append(s.Steps, StoryStep{
				StepIndex:        stepIndex,
				Role:             "user",
				Prompt:           promptStr,
				ExpectedText:     currentExpected,
				VisualAssertions: currentVisual,
				VisionPrompt:     currentVisionPrompt,
			})
		}
		currentPrompt.Reset()
		currentExpected = nil
		currentVisual = nil
		currentVisionPrompt = ""
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if stepHeaderRegex.MatchString(trimmed) {
			flushStep()
			continue
		}

		if strings.HasPrefix(trimmed, "- TextAssertion:") || strings.HasPrefix(trimmed, "* TextAssertion:") {
			val := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "- TextAssertion:"), "* TextAssertion:"))
			val = strings.Trim(val, "\"'")
			if val != "" {
				currentExpected = append(currentExpected, val)
			}
			continue
		}

		if strings.HasPrefix(trimmed, "- VisualAssertion:") || strings.HasPrefix(trimmed, "* VisualAssertion:") {
			val := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "- VisualAssertion:"), "* VisualAssertion:"))
			val = strings.Trim(val, "\"'")
			if val != "" {
				currentVisual = append(currentVisual, val)
			}
			continue
		}

		if strings.HasPrefix(trimmed, "- VisionJudge:") || strings.HasPrefix(trimmed, "* VisionJudge:") {
			val := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "- VisionJudge:"), "* VisionJudge:"))
			currentVisionPrompt = strings.Trim(val, "\"'")
			continue
		}

		if !strings.HasPrefix(trimmed, "#") {
			currentPrompt.WriteString(line + "\n")
		}
	}
	flushStep()
}

// DiscoverStories finds all .story.md and .md story files.
func (e *Engine) DiscoverStories() ([]Story, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	stories := make([]Story, 0)
	seen := make(map[string]bool)

	dirs := []string{e.storiesDir, "stories", ".agents/stories"}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || (!strings.HasSuffix(entry.Name(), ".md") && !strings.HasSuffix(entry.Name(), ".json")) {
				continue
			}
			filePath := filepath.Join(dir, entry.Name())
			data, err := os.ReadFile(filePath)
			if err != nil {
				continue
			}

			var story *Story
			if strings.HasSuffix(entry.Name(), ".json") {
				story = &Story{}
				if err := json.Unmarshal(data, story); err != nil {
					continue
				}
				story.Path = filePath
			} else {
				story, err = ParseStoryMarkdown(string(data), filePath)
				if err != nil {
					continue
				}
			}

			if story.ID == "" {
				story.ID = entry.Name()
			}
			if seen[story.ID] {
				continue
			}
			seen[story.ID] = true
			stories = append(stories, *story)
		}
	}

	return stories, nil
}

// RunStory executes a user story sequentially step-by-step against the local LLM.
func (e *Engine) RunStory(ctx context.Context, story Story) (*RunResult, error) {
	runID := fmt.Sprintf("run-%d", time.Now().UnixNano())
	res := &RunResult{
		RunID:       runID,
		StoryID:     story.ID,
		Status:      "running",
		StartedAt:   time.Now(),
		StepResults: make([]StepResult, 0, len(story.Steps)),
		Logs:        []string{fmt.Sprintf("Started replay for story %q (%d steps)", story.Name, len(story.Steps))},
	}

	e.mu.Lock()
	e.runs[runID] = res
	e.mu.Unlock()

	allPassed := true
	conversationHistory := make([]map[string]string, 0)

	for _, step := range story.Steps {
		stepStart := time.Now()
		stepRes := StepResult{
			StepIndex: step.StepIndex,
			Passed:    true,
		}

		if step.Prompt != "" {
			conversationHistory = append(conversationHistory, map[string]string{
				"role":    "user",
				"content": step.Prompt,
			})

			// Query local LLM if URL configured
			output, err := e.callLLM(ctx, conversationHistory)
			stepRes.Duration = time.Since(stepStart)
			if err != nil {
				stepRes.Passed = false
				stepRes.Errors = append(stepRes.Errors, fmt.Sprintf("LLM call failed: %v", err))
				allPassed = false
			} else {
				stepRes.Output = output
				conversationHistory = append(conversationHistory, map[string]string{
					"role":    "assistant",
					"content": output,
				})

				// Evaluate text assertions
				for _, expected := range step.ExpectedText {
					if !strings.Contains(strings.ToLower(output), strings.ToLower(expected)) {
						stepRes.Passed = false
						stepRes.Errors = append(stepRes.Errors, fmt.Sprintf("expected text %q not found in output", expected))
						allPassed = false
					}
				}
			}
		}

		res.StepResults = append(res.StepResults, stepRes)
		res.Logs = append(res.Logs, fmt.Sprintf("Step %d: passed=%v duration=%v", step.StepIndex, stepRes.Passed, stepRes.Duration))
	}

	res.CompletedAt = time.Now()
	res.Duration = res.CompletedAt.Sub(res.StartedAt)
	if allPassed {
		res.Status = "passed"
	} else {
		res.Status = "failed"
	}

	return res, nil
}

func (e *Engine) callLLM(ctx context.Context, messages []map[string]string) (string, error) {
	if e.llmURL == "" {
		return "[mock output for offline simulation]", nil
	}

	payload := map[string]any{
		"model":       "local",
		"messages":    messages,
		"temperature": 0.3,
		"max_tokens":  512,
		"stream":      false,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.llmURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if e.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+e.apiKey)
	}

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBytes, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("LLM upstream error HTTP %d: %s", resp.StatusCode, string(respBytes))
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", err
	}
	if len(parsed.Choices) > 0 {
		out := parsed.Choices[0].Message.Content
		if out == "" && parsed.Choices[0].Message.ReasoningContent != "" {
			out = parsed.Choices[0].Message.ReasoningContent
		}
		return strings.TrimSpace(out), nil
	}
	return "", nil
}

// Handle serves /mock and /mock/* endpoints.
func (e *Engine) Handle(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/mock")
	path = strings.TrimPrefix(path, "/")

	switch {
	case path == "stories" || path == "":
		if r.Method == http.MethodGet {
			stories, err := e.DiscoverStories()
			if err != nil {
				httpx.ErrorDetail(w, r, http.StatusInternalServerError, "discover stories failed", err.Error())
				return
			}
			httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"stories": stories})
			return
		}
		httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")

	case strings.HasPrefix(path, "stories/"):
		storyID := strings.TrimPrefix(path, "stories/")
		stories, err := e.DiscoverStories()
		if err != nil {
			httpx.ErrorDetail(w, r, http.StatusInternalServerError, "discover stories failed", err.Error())
			return
		}
		for _, s := range stories {
			if s.ID == storyID {
				httpx.WriteJSON(w, r, http.StatusOK, s)
				return
			}
		}
		httpx.Error(w, r, http.StatusNotFound, "story not found")

	case path == "replay":
		if r.Method != http.MethodPost {
			httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req struct {
			StoryID string `json:"story_id"`
			Raw     string `json:"raw_markdown,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			httpx.ErrorDetail(w, r, http.StatusBadRequest, "invalid request body", err.Error())
			return
		}

		var targetStory Story
		if req.Raw != "" {
			parsed, err := ParseStoryMarkdown(req.Raw, "memory.story.md")
			if err != nil {
				httpx.ErrorDetail(w, r, http.StatusBadRequest, "invalid story markdown", err.Error())
				return
			}
			targetStory = *parsed
		} else {
			stories, err := e.DiscoverStories()
			if err != nil {
				httpx.ErrorDetail(w, r, http.StatusInternalServerError, "discover stories failed", err.Error())
				return
			}
			found := false
			for _, s := range stories {
				if s.ID == req.StoryID {
					targetStory = s
					found = true
					break
				}
			}
			if !found {
				httpx.Error(w, r, http.StatusNotFound, "story not found")
				return
			}
		}

		res, err := e.RunStory(r.Context(), targetStory)
		if err != nil {
			httpx.ErrorDetail(w, r, http.StatusInternalServerError, "run story failed", err.Error())
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, res)

	case strings.HasPrefix(path, "status/"):
		runID := strings.TrimPrefix(path, "status/")
		e.mu.RLock()
		res, ok := e.runs[runID]
		e.mu.RUnlock()
		if !ok {
			httpx.Error(w, r, http.StatusNotFound, "run not found")
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, res)

	default:
		httpx.Error(w, r, http.StatusNotFound, "not found")
	}
}
