package skills

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleSkillMD = `---
name: sample-skill
version: 1.2.0
description: A test skill for validating the parser
scope: card
tags: [test, automation, evaluation]
macros:
  - trigger: test_macro
    text: "expansion value"
---

# Sample Skill

## System Prompt
You are a test assistant skilled in verification.

## Personality
Precise, robotic, and helpful.

## Knowledge / RAG Storybook
# sample_knowledge
tags: test [1.0]
use: Test knowledge entry

## Card-Code Hooks
` + "```javascript" + `
gobbo.on('send', (text, ctx) => {
  return text + " [verified]";
});
` + "```" + `

## Scoped Styles
` + "```css" + `
.sample-badge { color: red; }
` + "```" + `

## Carousel Lines
- Test prompt direction 1
- Test prompt direction 2
`

func TestParseSkillMarkdown(t *testing.T) {
	skill, err := ParseSkillMarkdown(sampleSkillMD, "skills/sample-skill/SKILL.md")
	if err != nil {
		t.Fatalf("ParseSkillMarkdown failed: %v", err)
	}

	if skill.Name != "sample-skill" {
		t.Errorf("expected name 'sample-skill', got %q", skill.Name)
	}
	if skill.Version != "1.2.0" {
		t.Errorf("expected version '1.2.0', got %q", skill.Version)
	}
	if skill.Description != "A test skill for validating the parser" {
		t.Errorf("expected description 'A test skill for validating the parser', got %q", skill.Description)
	}
	if skill.Scope != "card" {
		t.Errorf("expected scope 'card', got %q", skill.Scope)
	}
	if len(skill.Tags) != 3 || skill.Tags[0] != "test" || skill.Tags[2] != "evaluation" {
		t.Errorf("unexpected tags: %v", skill.Tags)
	}
	if len(skill.Macros) != 1 || skill.Macros[0].Trigger != "test_macro" || skill.Macros[0].Text != "expansion value" {
		t.Errorf("unexpected macros: %+v", skill.Macros)
	}
	if !strings.Contains(skill.SystemPrompt, "verification") {
		t.Errorf("unexpected system prompt: %q", skill.SystemPrompt)
	}
	if !strings.Contains(skill.Personality, "robotic") {
		t.Errorf("unexpected personality: %q", skill.Personality)
	}
	if !strings.Contains(skill.Storybook, "sample_knowledge") {
		t.Errorf("unexpected storybook: %q", skill.Storybook)
	}
	if !strings.Contains(skill.Code, "gobbo.on('send'") {
		t.Errorf("unexpected code: %q", skill.Code)
	}
	if !strings.Contains(skill.Styles, ".sample-badge") {
		t.Errorf("unexpected styles: %q", skill.Styles)
	}
	if len(skill.CarouselLines) != 2 || skill.CarouselLines[0] != "Test prompt direction 1" {
		t.Errorf("unexpected carousel lines: %v", skill.CarouselLines)
	}
}

func TestManagerDiscoveryAndCRUD(t *testing.T) {
	tempDir := t.TempDir()
	mgr := NewManager(tempDir)

	// Initially empty
	skills, err := mgr.Discover()
	if err != nil {
		t.Fatalf("Discover failed: %v", err)
	}
	if len(skills) != 0 {
		t.Fatalf("expected 0 skills, got %d", len(skills))
	}

	// Save a new skill
	saved, err := mgr.Save("sample-skill", sampleSkillMD)
	if err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	if saved.Name != "sample-skill" {
		t.Errorf("expected saved name 'sample-skill', got %q", saved.Name)
	}

	// Verify file was written
	content, err := os.ReadFile(filepath.Join(tempDir, "sample-skill", "SKILL.md"))
	if err != nil {
		t.Fatalf("read written SKILL.md failed: %v", err)
	}
	if string(content) != sampleSkillMD {
		t.Errorf("file content mismatch")
	}

	// Get by name
	retrieved, err := mgr.Get("sample-skill")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if retrieved.Name != "sample-skill" {
		t.Errorf("expected retrieved name 'sample-skill', got %q", retrieved.Name)
	}

	// Discover again
	skills, err = mgr.Discover()
	if err != nil {
		t.Fatalf("Discover failed: %v", err)
	}
	if len(skills) != 1 {
		t.Fatalf("expected 1 skill, got %d", len(skills))
	}
}

func TestHTTPHandler(t *testing.T) {
	tempDir := t.TempDir()
	mgr := NewManager(tempDir)

	// Save a skill first
	_, err := mgr.Save("sample-skill", sampleSkillMD)
	if err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Test GET /skills
	req := httptest.NewRequest(http.MethodGet, "/skills", nil)
	rec := httptest.NewRecorder()
	mgr.Handle(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /skills code: %d, body: %s", rec.Code, rec.Body.String())
	}

	var listResp struct {
		Skills []Skill `json:"skills"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("unmarshal list response: %v", err)
	}
	if len(listResp.Skills) != 1 {
		t.Fatalf("expected 1 skill in list, got %d", len(listResp.Skills))
	}

	// Test GET /skills/sample-skill
	req = httptest.NewRequest(http.MethodGet, "/skills/sample-skill", nil)
	rec = httptest.NewRecorder()
	mgr.Handle(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /skills/sample-skill code: %d", rec.Code)
	}

	// Test PUT /skills/sample-skill
	putBody := `{"raw_markdown": "---\nname: sample-skill\nversion: 2.0.0\n---\n# Updated"}`
	req = httptest.NewRequest(http.MethodPut, "/skills/sample-skill", strings.NewReader(putBody))
	rec = httptest.NewRecorder()
	mgr.Handle(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /skills/sample-skill code: %d, body: %s", rec.Code, rec.Body.String())
	}

	// Verify updated version
	updated, err := mgr.Get("sample-skill")
	if err != nil {
		t.Fatalf("get after PUT failed: %v", err)
	}
	if updated.Version != "2.0.0" {
		t.Errorf("expected updated version 2.0.0, got %q", updated.Version)
	}
}
