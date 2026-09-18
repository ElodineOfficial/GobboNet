package static

import (
	"testing"
	"testing/fstest"
)

// The path rules predate this package moving onto fs.FS, and they are the only
// thing standing between a request path and the filesystem. The move is exactly
// the kind of change that quietly loosens one, so they get pinned here.
func testFS() fstest.MapFS {
	return fstest.MapFS{
		"chat.html":         {Data: []byte("page")},
		"js/01-config.js":   {Data: []byte("js")},
		"css/01-tokens.css": {Data: []byte("css")},
		".gitkeep":          {Data: []byte("secret")},
		"sub/.hidden":       {Data: []byte("secret")},
		"v1..2.json":        {Data: []byte("legit")},
	}
}

func TestResolveServesOrdinaryFiles(t *testing.T) {
	fsys := testFS()
	for _, tc := range []struct{ url, want string }{
		{"/", "chat.html"},
		{"", "chat.html"},
		{"/chat.html", "chat.html"},
		{"/js/01-config.js", "js/01-config.js"},
		{"/css/01-tokens.css", "css/01-tokens.css"},
		// A ".." that is not a whole path segment is a legal filename, and
		// matching the bare string would refuse it.
		{"/v1..2.json", "v1..2.json"},
	} {
		got, ok := Resolve(fsys, tc.url)
		if !ok || got != tc.want {
			t.Errorf("Resolve(%q) = %q, %v; want %q, true", tc.url, got, ok, tc.want)
		}
	}
}

func TestResolveRefusesEscapesAndInternals(t *testing.T) {
	fsys := testFS()
	for _, url := range []string{
		"/../config.toml",
		"/../../etc/passwd",
		"/js/../../config.toml",
		// Percent-encoded traversal: the checks have to run on the decoded form
		// or this walks straight out of the root.
		"/%2e%2e/config.toml",
		"/%2E%2E%2Fconfig.toml",
		// Dot-prefixed segments are server internals by convention.
		"/.gitkeep",
		"/sub/.hidden",
		// Backslash is a literal character in an fs.FS name, so a Windows-style
		// traversal must be refused outright rather than treated as a path.
		`/..\config.toml`,
		"/..%5Cconfig.toml",
		// Absolute and root-escaping forms.
		"//etc/passwd",
		"/missing.html",
	} {
		if got, ok := Resolve(fsys, url); ok {
			t.Errorf("Resolve(%q) = %q, true; want refused", url, got)
		}
	}
}

func TestResolveRefusesDirectories(t *testing.T) {
	// A directory is not a file to send. Before the fs.FS move this was an
	// IsRegular check on an os.FileInfo; it still has to be one.
	if got, ok := Resolve(testFS(), "/js"); ok {
		t.Errorf("Resolve(%q) = %q, true; want refused", "/js", got)
	}
}
