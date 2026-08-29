// Package skills implements discovery, parsing, and management of GobboNet skills.
//
// Skills are filesystem-based bundles (skills/<name>/SKILL.md) that layer
// prompt fragments, storybooks, carousel lines, macros, and card-code hooks
// onto character cards or execute globally.
package skills

import (
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

	"github.com/jmccardle/gobbonet/internal/httpx"
)

// MacroDef defines a macro trigger and its replacement text provided by a skill.
type MacroDef struct {
	Trigger string `json:"trigger"`
	Text    string `json:"text"`
}

// Skill represents a fully parsed GobboNet skill definition.
type Skill struct {
	Name          string     `json:"name"`
	Version       string     `json:"version"`
	Description   string     `json:"description"`
	Scope         string     `json:"scope"` // "card" or "global" (default "global")
	Tags          []string   `json:"tags"`
	Macros        []MacroDef `json:"macros"`
	SystemPrompt  string     `json:"system_prompt"`
	Personality   string     `json:"personality"`
	Storybook     string     `json:"storybook"`
	Code          string     `json:"code"`
	Styles        string     `json:"styles"`
	CarouselLines []string   `json:"carousel_lines"`
	RawMarkdown   string     `json:"raw_markdown"`
	Path          string     `json:"path"`
}

var validNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// ParseSkillMarkdown parses the raw text of a SKILL.md file into a Skill struct.
func ParseSkillMarkdown(raw string, path string) (*Skill, error) {
	skill := &Skill{
		Scope:         "global",
		Tags:          []string{},
		Macros:        []MacroDef{},
		CarouselLines: []string{},
		RawMarkdown:   raw,
		Path:          path,
	}

	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	if len(lines) == 0 {
		return nil, errors.New("empty skill file")
	}

	bodyStartIndex := 0
	// Check for YAML frontmatter
	if strings.TrimSpace(lines[0]) == "---" {
		endIndex := -1
		for i := 1; i < len(lines); i++ {
			if strings.TrimSpace(lines[i]) == "---" {
				endIndex = i
				break
			}
		}
		if endIndex != -1 {
			frontmatterLines := lines[1:endIndex]
			parseFrontmatter(frontmatterLines, skill)
			bodyStartIndex = endIndex + 1
		}
	}

	// Fallback name from directory if not present in frontmatter
	if skill.Name == "" && path != "" {
		dirName := filepath.Base(filepath.Dir(path))
		if dirName != "." && dirName != "/" {
			skill.Name = dirName
		}
	}

	// Parse markdown sections from body
	if bodyStartIndex < len(lines) {
		bodyText := strings.Join(lines[bodyStartIndex:], "\n")
		parseMarkdownSections(bodyText, skill)
	}

	return skill, nil
}

func parseFrontmatter(lines []string, s *Skill) {
	var currentKey string
	var inMacros bool
	var currentMacro *MacroDef

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		if inMacros {
			if strings.HasPrefix(trimmed, "-") {
				if currentMacro != nil && currentMacro.Trigger != "" {
					s.Macros = append(s.Macros, *currentMacro)
				}
				currentMacro = &MacroDef{}
				rest := strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))
				if strings.Contains(rest, ":") {
					parts := strings.SplitN(rest, ":", 2)
					k := strings.ToLower(strings.TrimSpace(parts[0]))
					v := strings.Trim(strings.TrimSpace(parts[1]), "\"'")
					if k == "trigger" {
						currentMacro.Trigger = v
					} else if k == "text" {
						currentMacro.Text = v
					}
				}
				continue
			} else if strings.HasPrefix(line, "  ") || strings.HasPrefix(line, "\t") {
				if currentMacro != nil && strings.Contains(trimmed, ":") {
					parts := strings.SplitN(trimmed, ":", 2)
					k := strings.ToLower(strings.TrimSpace(parts[0]))
					v := strings.Trim(strings.TrimSpace(parts[1]), "\"'")
					if k == "trigger" {
						currentMacro.Trigger = v
					} else if k == "text" {
						currentMacro.Text = v
					}
				}
				continue
			} else {
				if currentMacro != nil && currentMacro.Trigger != "" {
					s.Macros = append(s.Macros, *currentMacro)
					currentMacro = nil
				}
				inMacros = false
			}
		}

		if strings.Contains(trimmed, ":") {
			parts := strings.SplitN(trimmed, ":", 2)
			key := strings.ToLower(strings.TrimSpace(parts[0]))
			val := strings.TrimSpace(parts[1])
			val = strings.Trim(val, "\"'")

			currentKey = key
			switch key {
			case "name":
				s.Name = val
			case "version":
				s.Version = val
			case "description":
				if val == ">-" || val == ">" || val == "|" {
					s.Description = ""
				} else {
					s.Description = val
				}
			case "scope":
				if val == "card" || val == "global" {
					s.Scope = val
				}
			case "tags":
				if strings.HasPrefix(val, "[") && strings.HasSuffix(val, "]") {
					inner := strings.Trim(val, "[]")
					for _, item := range strings.Split(inner, ",") {
						tag := strings.Trim(strings.TrimSpace(item), "\"'")
						if tag != "" {
							s.Tags = append(s.Tags, tag)
						}
					}
				}
			case "macros":
				inMacros = true
			}
		} else if currentKey == "description" && (strings.HasPrefix(line, "  ") || strings.HasPrefix(line, "\t")) {
			if s.Description != "" {
				s.Description += " " + trimmed
			} else {
				s.Description = trimmed
			}
		}
	}

	if currentMacro != nil && currentMacro.Trigger != "" {
		s.Macros = append(s.Macros, *currentMacro)
	}
}

func isSectionHeader(title string) bool {
	t := strings.ToLower(strings.TrimSpace(title))
	t = strings.TrimPrefix(t, "skill ")
	return t == "system prompt" ||
		t == "system prompt contribution" ||
		t == "personality" ||
		t == "personality contribution" ||
		t == "knowledge" ||
		t == "rag storybook" ||
		t == "knowledge / rag storybook" ||
		t == "storybook" ||
		t == "card-code hooks" ||
		t == "card-code" ||
		t == "card code" ||
		t == "code" ||
		t == "hooks" ||
		t == "scoped styles" ||
		t == "styles" ||
		t == "css" ||
		t == "carousel" ||
		t == "carousel lines" ||
		t == "carousel prompts" ||
		strings.HasPrefix(t, "system prompt") ||
		strings.HasPrefix(t, "personality") ||
		strings.HasPrefix(t, "knowledge") ||
		strings.HasPrefix(t, "rag") ||
		strings.HasPrefix(t, "storybook") ||
		strings.HasPrefix(t, "card-code") ||
		strings.HasPrefix(t, "card code") ||
		strings.HasPrefix(t, "carousel") ||
		strings.HasPrefix(t, "scoped style")
}

func parseMarkdownSections(body string, s *Skill) {
	lines := strings.Split(body, "\n")
	var currentSection string
	var sectionLines []string

	flushSection := func() {
		if currentSection == "" {
			sectionLines = nil
			return
		}
		content := strings.TrimSpace(strings.Join(sectionLines, "\n"))
		secLower := strings.ToLower(currentSection)

		switch {
		case strings.Contains(secLower, "system prompt"):
			s.SystemPrompt = content
		case strings.Contains(secLower, "personality"):
			s.Personality = content
		case strings.Contains(secLower, "knowledge") || strings.Contains(secLower, "storybook") || strings.Contains(secLower, "rag"):
			s.Storybook = content
		case strings.Contains(secLower, "hook") || strings.Contains(secLower, "card-code") || strings.Contains(secLower, "card code") || strings.Contains(secLower, "code"):
			s.Code = extractCodeBlock(content)
		case strings.Contains(secLower, "style") || strings.Contains(secLower, "css"):
			s.Styles = extractCodeBlock(content)
		case strings.Contains(secLower, "carousel"):
			for _, line := range sectionLines {
				lineTrim := strings.TrimSpace(line)
				if strings.HasPrefix(lineTrim, "- ") || strings.HasPrefix(lineTrim, "* ") {
					item := strings.TrimSpace(lineTrim[2:])
					if item != "" {
						s.CarouselLines = append(s.CarouselLines, item)
					}
				} else if lineTrim != "" && !strings.HasPrefix(lineTrim, "#") {
					s.CarouselLines = append(s.CarouselLines, lineTrim)
				}
			}
		}
		sectionLines = nil
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## ") {
			headerTitle := strings.TrimSpace(strings.TrimPrefix(trimmed, "## "))
			if isSectionHeader(headerTitle) {
				flushSection()
				currentSection = headerTitle
				continue
			}
		}
		sectionLines = append(sectionLines, line)
	}
	flushSection()
}

func extractCodeBlock(text string) string {
	lines := strings.Split(text, "\n")
	var inside bool
	var blockLines []string

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			if !inside {
				inside = true
				continue
			} else {
				inside = false
				break
			}
		}
		if inside {
			blockLines = append(blockLines, line)
		}
	}

	if len(blockLines) > 0 {
		return strings.Join(blockLines, "\n")
	}
	return text
}

// Manager handles discovery, reading, and saving skills.
type Manager struct {
	mu        sync.RWMutex
	skillsDir string
}

// NewManager creates a skills manager anchored at skillsDir.
func NewManager(skillsDir string) *Manager {
	return &Manager{
		skillsDir: skillsDir,
	}
}

// Discover scans the configured directory and returns all parsed skills.
func (m *Manager) Discover() ([]Skill, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	results := make([]Skill, 0)
	seen := make(map[string]bool)

	dirsToScan := []string{m.skillsDir, ".agents/skills"}
	for _, dir := range dirsToScan {
		if dir == "" {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}

		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			dirName := entry.Name()

			skillFile := filepath.Join(dir, dirName, "SKILL.md")
			data, err := os.ReadFile(skillFile)
			if err != nil {
				continue
			}

			skill, err := ParseSkillMarkdown(string(data), skillFile)
			if err != nil {
				continue
			}
			if skill.Name == "" {
				skill.Name = dirName
			}
			if seen[skill.Name] {
				continue
			}
			seen[skill.Name] = true
			results = append(results, *skill)
		}
	}

	return results, nil
}

// Get finds a skill by name or directory name.
func (m *Manager) Get(name string) (*Skill, error) {
	skills, err := m.Discover()
	if err != nil {
		return nil, err
	}
	for _, s := range skills {
		if s.Name == name || filepath.Base(filepath.Dir(s.Path)) == name {
			return &s, nil
		}
	}
	return nil, os.ErrNotExist
}

// Save writes or updates a skill's SKILL.md file.
func (m *Manager) Save(name string, rawMarkdown string) (*Skill, error) {
	if !validNamePattern.MatchString(name) {
		return nil, fmt.Errorf("invalid skill name %q: must contain only letters, numbers, hyphens, and underscores", name)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	targetDir := filepath.Join(m.skillsDir, name)
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return nil, fmt.Errorf("create skill directory: %w", err)
	}

	targetFile := filepath.Join(targetDir, "SKILL.md")
	tmpFile := targetFile + ".tmp"
	if err := os.WriteFile(tmpFile, []byte(rawMarkdown), 0o644); err != nil {
		return nil, fmt.Errorf("write skill temp file: %w", err)
	}
	if err := os.Rename(tmpFile, targetFile); err != nil {
		_ = os.Remove(tmpFile)
		return nil, fmt.Errorf("rename skill file: %w", err)
	}

	return ParseSkillMarkdown(rawMarkdown, targetFile)
}

// Handle routes requests under /skills and /skills/*
func (m *Manager) Handle(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/skills")
	path = strings.TrimPrefix(path, "/")

	if path == "" {
		if r.Method == http.MethodGet {
			list, err := m.Discover()
			if err != nil {
				httpx.ErrorDetail(w, r, http.StatusInternalServerError, "failed to discover skills", err.Error())
				return
			}
			httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"skills": list})
			return
		}
		httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// Subpath is skill name e.g. /skills/code-review
	skillName := path
	if strings.Contains(skillName, "/") {
		parts := strings.Split(skillName, "/")
		skillName = parts[0]
	}

	switch r.Method {
	case http.MethodGet:
		skill, err := m.Get(skillName)
		if err != nil {
			httpx.Error(w, r, http.StatusNotFound, "skill not found")
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, skill)

	case http.MethodPut, http.MethodPost:
		bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 2<<20)) // 2 MiB limit
		if err != nil {
			httpx.ErrorDetail(w, r, http.StatusBadRequest, "could not read body", err.Error())
			return
		}

		rawMarkdown := string(bodyBytes)
		// Check if payload is JSON wrapper {"raw_markdown": "..."}
		var payload struct {
			RawMarkdown string `json:"raw_markdown"`
		}
		if json.Unmarshal(bodyBytes, &payload) == nil && payload.RawMarkdown != "" {
			rawMarkdown = payload.RawMarkdown
		}

		skill, err := m.Save(skillName, rawMarkdown)
		if err != nil {
			httpx.ErrorDetail(w, r, http.StatusInternalServerError, "failed to save skill", err.Error())
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, skill)

	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
	}
}
