package mcp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

// callResult is MCP's CallToolResult.
type callResult struct {
	Content           []json.RawMessage `json:"content"`
	StructuredContent json.RawMessage   `json:"structuredContent"`
	IsError           bool              `json:"isError"`
}

type contentPart struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
	URI      string `json:"uri"`
	Name     string `json:"name"`
	Resource *struct {
		URI      string  `json:"uri"`
		MimeType string  `json:"mimeType"`
		Text     *string `json:"text"`
		Blob     string  `json:"blob"`
	} `json:"resource"`
}

// render is the result as the text a character reads. Text parts are kept as
// they are; anything a text model cannot read (an image, audio, a binary
// file) is named in a line saying it was not shown, so the character knows
// it exists rather than seeing nothing.
func (r callResult) render() string {
	var parts []string
	for _, raw := range r.Content {
		var p contentPart
		if json.Unmarshal(raw, &p) != nil {
			continue
		}
		switch p.Type {
		case "text":
			parts = append(parts, p.Text)
		case "image", "audio":
			parts = append(parts, fmt.Sprintf("[%s (%s, %s) not shown]", p.Type, orUnknown(p.MimeType), approxSize(p.Data)))
		case "resource":
			switch {
			case p.Resource == nil:
			case p.Resource.Text != nil:
				parts = append(parts, *p.Resource.Text)
			default:
				parts = append(parts, fmt.Sprintf("[file %s (%s, %s) not shown]", clip(p.Resource.URI, 300), orUnknown(p.Resource.MimeType), approxSize(p.Resource.Blob)))
			}
		case "resource_link":
			name := p.Name
			if name == "" {
				name = "link"
			}
			parts = append(parts, fmt.Sprintf("[%s: %s]", clip(name, 200), clip(p.URI, 500)))
		default:
			parts = append(parts, fmt.Sprintf("[%s content not shown]", clip(p.Type, 40)))
		}
	}
	if len(parts) == 0 && len(r.StructuredContent) > 0 && string(r.StructuredContent) != "null" {
		var buf bytes.Buffer
		if json.Compact(&buf, r.StructuredContent) == nil {
			return buf.String()
		}
	}
	return strings.Join(parts, "\n\n")
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown type"
	}
	return clip(s, 80)
}

// approxSize is the decoded size of base64 data, for a person to read.
func approxSize(b64 string) string {
	n := len(b64) * 3 / 4
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%d KB", n>>10)
	}
	return fmt.Sprintf("%d bytes", n)
}

// cutRunes keeps the first n characters of s.
func cutRunes(s string, n int) (string, bool) {
	r := []rune(s)
	if len(r) <= n {
		return s, false
	}
	return string(r[:n]), true
}

// logWriter is one server's log file, mcp-<name>.log. It holds the program's
// error output and GobboNet's own lines about it (marked [gobbonet]), and
// never a tool's arguments or results. It stops growing at logCap, so a
// chatty server cannot fill the disk over a long run.
type logWriter struct {
	mu   sync.Mutex
	f    *os.File
	n    int64
	full bool
}

const logCap = 8 << 20

func (l *logWriter) Write(p []byte) (int, error) {
	if l == nil {
		return len(p), nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil || l.full {
		return len(p), nil
	}
	if l.n+int64(len(p)) > logCap {
		l.full = true
		fmt.Fprintf(l.f, "%s [gobbonet] this log reached %d MB; nothing more is written until GobboNet restarts\n", time.Now().Format("15:04:05"), logCap>>20)
		return len(p), nil
	}
	n, err := l.f.Write(p)
	l.n += int64(n)
	return len(p), err
}

func (l *logWriter) logf(format string, args ...any) {
	if l == nil {
		return
	}
	fmt.Fprintf(l, "%s %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, args...))
}

func (l *logWriter) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
}

// tailLines keeps the last few lines a program wrote to stderr, for the
// detail of a failure: "it exited (exit status 1): Error: Cannot find module".
type tailLines struct {
	mu    sync.Mutex
	lines []string
}

func (t *tailLines) add(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lines = append(t.lines, clip(line, 300))
	if len(t.lines) > 20 {
		t.lines = t.lines[len(t.lines)-20:]
	}
}

func (t *tailLines) last() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.lines) == 0 {
		return ""
	}
	return t.lines[len(t.lines)-1]
}

// copyStderr drains a program's stderr into its log, keeping the last lines.
// It never stops reading before the pipe closes: a program whose stderr
// nobody reads blocks once the pipe fills, which would look like a hung tool.
func copyStderr(r io.ReadCloser, logw *logWriter, tail *tailLines) {
	defer r.Close()
	br := bufio.NewReaderSize(r, 16<<10)
	var line []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if len(chunk) > 0 {
			logw.Write(chunk) //nolint:errcheck // a log that cannot be written is not a reason to stop draining
			if len(line) < 4096 {
				line = append(line, chunk...)
			}
			if chunk[len(chunk)-1] == '\n' {
				tail.add(string(line))
				line = line[:0]
			}
		}
		if err != nil {
			if errors.Is(err, bufio.ErrBufferFull) {
				continue
			}
			if len(line) > 0 {
				tail.add(string(line))
			}
			return
		}
	}
}
