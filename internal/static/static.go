// Package static serves the web root. Port of Resolve-StaticPath and the static
// fallthrough branch of fileserver.ps1's dispatcher.
//
// It takes an fs.FS rather than a directory path, because since 1.7.5 the
// frontend normally lives inside the binary (see internal/webui) and a disk
// directory is only one of the two things it can be. The path rules below are
// unchanged; what moved is where the bytes come from.
package static

import (
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/httpx"
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

// Resolve maps a request path to a name inside fsys, or returns ok=false.
//
// The returned name is an io/fs name: slash-separated, no leading slash, no
// "..". Escaping the root is refused three times over — textually here, by
// fs.ValidPath, and (for a disk override) by the os.Root the FS is opened
// through in webui.Overlay, which is the only one of the three that a symlink
// cannot talk its way past.
func Resolve(fsys fs.FS, urlPath string) (string, bool) {
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
	// A Windows-style separator or a drive-absolute path must not be treated as
	// a path at all: io/fs names are slash-only, so a backslash is a literal
	// character in a filename and "..\\x" would otherwise slip past the
	// traversal check on a Unix host serving a Windows-authored request.
	if strings.ContainsRune(rel, '\\') || strings.HasPrefix(rel, "/") {
		return "", false
	}

	name := path.Clean(rel)
	if !fs.ValidPath(name) || name == "." {
		return "", false
	}

	info, err := fs.Stat(fsys, name)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return name, true
}

// Serve writes the file at urlPath, or a 404 envelope.
func Serve(w http.ResponseWriter, r *http.Request, fsys fs.FS, urlPath string) {
	name, ok := Resolve(fsys, urlPath)
	if !ok {
		httpx.WriteJSON(w, r, http.StatusNotFound, map[string]string{
			"error": "not found",
			"path":  urlPath,
		})
		return
	}
	f, err := fsys.Open(name)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
		return
	}
	defer f.Close()
	body, err := io.ReadAll(f)
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "read failed", err.Error())
		return
	}
	httpx.WriteBytes(w, r, http.StatusOK, httpx.MimeType(name), body)
}
