// Package static serves the web root. Port of Resolve-StaticPath and the static
// fallthrough branch of fileserver.ps1's dispatcher.
package static

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/jmccardle/gobbonet/internal/httpx"
)

var (
	// A ".." that is a whole path segment. Matching the bare string would
	// reject legitimate names like "v1..2.json".
	traversalRe = regexp.MustCompile(`(^|[\\/])\.\.([\\/]|$)`)
	// Any segment starting with a dot. Server internals — the state backup,
	// swap status, .git — all live behind dot names, and everything a client
	// legitimately needs from them has a dedicated route.
	dotfileRe = regexp.MustCompile(`(^|[\\/])\.`)
)

// Resolve maps a request path to a file inside webRoot, or returns ok=false.
func Resolve(webRoot, urlPath string) (string, bool) {
	if urlPath == "" || urlPath == "/" {
		urlPath = "/chat.html"
	}

	rel, err := url.PathUnescape(strings.TrimLeft(urlPath, "/"))
	if err != nil {
		return "", false
	}
	// %2e%2e and friends decode into traversal, so the checks must run on the
	// decoded form.
	if rel == "" || traversalRe.MatchString(rel) || dotfileRe.MatchString(rel) {
		return "", false
	}
	// An absolute path in the request must not escape the root.
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, `\`) {
		return "", false
	}

	candidate := filepath.Join(webRoot, filepath.FromSlash(rel))

	// Belt and braces: confirm the resolved path is still inside the root even
	// after symlinks. A symlink in web/ pointing at /etc would pass every
	// textual check above.
	rootReal, err := filepath.EvalSymlinks(webRoot)
	if err != nil {
		return "", false
	}
	candidateReal, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", false
	}
	relToRoot, err := filepath.Rel(rootReal, candidateReal)
	if err != nil || relToRoot == ".." || strings.HasPrefix(relToRoot, ".."+string(filepath.Separator)) {
		return "", false
	}

	info, err := os.Stat(candidateReal)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return candidateReal, true
}

// Serve writes the file at urlPath, or a 404 envelope.
func Serve(w http.ResponseWriter, r *http.Request, webRoot, urlPath string) {
	path, ok := Resolve(webRoot, urlPath)
	if !ok {
		httpx.WriteJSON(w, r, http.StatusNotFound, map[string]string{
			"error": "not found",
			"path":  urlPath,
		})
		return
	}
	body, err := os.ReadFile(path)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
		return
	}
	httpx.WriteBytes(w, r, http.StatusOK, httpx.MimeType(path), body)
}
