// Package httpx holds the response helpers and the header policy every route
// shares. Port of fileserver.ps1's Write-Json / Write-Text / Add-CommonHeaders /
// Get-MimeType helpers.
package httpx

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
)

// mimeTypes maps extensions the app actually serves. Anything unknown becomes
// application/octet-stream, which is the safe default: a browser will download
// it rather than guess and execute it.
var mimeTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".htm":   "text/html; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".js":    "application/javascript; charset=utf-8",
	".mjs":   "application/javascript; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".webp":  "image/webp",
	".ico":   "image/x-icon",
	".txt":   "text/plain; charset=utf-8",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".map":   "application/json; charset=utf-8",
	".jinja": "text/plain; charset=utf-8",
}

// MimeType returns the Content-Type for a path.
func MimeType(path string) string {
	if t, ok := mimeTypes[strings.ToLower(filepath.Ext(path))]; ok {
		return t
	}
	return "application/octet-stream"
}

// CommonHeaders applies the permissive CORS policy plus no-store.
//
// Access-Control-Allow-Origin stays "*" deliberately. Browsers refuse "*" for
// credentialed XHR anyway, and form POSTs and <img> loads aren't gated by CORS
// at all — so the auth gate, not CORS, is the real boundary here. Keeping "*"
// is what lets a phone on the LAN and a file:// copy of chat.html share one
// backend without preflight friction.
//
// Must be called before WriteHeader.
func CommonHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	h.Set("Cache-Control", "no-store")
}

// WriteJSON serialises v and sends it with the common headers.
func WriteJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		// Marshalling our own response types can only fail on a programming
		// error; degrade to a fixed body rather than a half-written response.
		body = []byte(`{"error":"response encoding failed"}`)
		status = http.StatusInternalServerError
	}
	WriteBytes(w, r, status, "application/json; charset=utf-8", body)
}

// WriteText sends a string body with an explicit content type.
func WriteText(w http.ResponseWriter, r *http.Request, status int, contentType, body string) {
	WriteBytes(w, r, status, contentType, []byte(body))
}

// WriteBytes is the single exit point for buffered responses: it sets the
// common headers, the content type and an explicit length, then writes the body
// unless this is a HEAD request.
func WriteBytes(w http.ResponseWriter, r *http.Request, status int, contentType string, body []byte) {
	CommonHeaders(w)
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	if r != nil && r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
}

// WriteRedirect sends a 302 with the common headers.
func WriteRedirect(w http.ResponseWriter, location string) {
	CommonHeaders(w)
	w.Header().Set("Location", location)
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(http.StatusFound)
}

// Error sends the standard {"error": ...} envelope every route uses.
func Error(w http.ResponseWriter, r *http.Request, status int, message string) {
	WriteJSON(w, r, status, map[string]string{"error": message})
}

// ErrorDetail sends {"error":..., "detail":...} for failures where the
// underlying cause is worth surfacing to the client.
func ErrorDetail(w http.ResponseWriter, r *http.Request, status int, message, detail string) {
	WriteJSON(w, r, status, map[string]string{"error": message, "detail": detail})
}
