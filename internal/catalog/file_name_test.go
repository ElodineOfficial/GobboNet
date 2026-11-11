package catalog

import (
	"fmt"
	"strings"
	"testing"
)

// A catalogue entry's file becomes the download's name in the models folder.
// A name that is not a plain .gguf file -- "../x.gguf", "sub/x.gguf" -- would
// write somewhere else, so both loaders drop the entry and keep the rest
// (1.8.0, with the swap name check). The remote list comes over the network,
// so it gets the same rule as models.ini.

var escapingFiles = []string{"../escaped.gguf", "../../x.gguf", "sub/x.gguf", `sub\x.gguf`, "/abs/x.gguf", "x.txt", "x.gguf:s"}

func TestLoadDropsEntriesWhoseFileIsNotAPlainGGUFName(t *testing.T) {
	body := sample
	for i, f := range escapingFiles {
		body += fmt.Sprintf("\r\n[%d]\r\ndisplay=Bad %d\r\nrepo=r/bad\r\nfile=%s\r\nsize_gb=1\r\n", 40+i, i, f)
	}
	c, err := Load(write(t, body))
	if err != nil {
		t.Fatalf("bad rows killed the whole catalogue: %v", err)
	}
	for i, f := range escapingFiles {
		if e, ok := c.Find(40 + i); ok {
			t.Errorf("models.ini entry with file %q was offered for download: %+v", f, e)
		}
	}
	if _, ok := c.Find(1); !ok {
		t.Error("the good entries were lost along with the bad ones")
	}
}

func TestParseRemoteDropsEntriesWhoseFileIsNotAPlainGGUFName(t *testing.T) {
	rows := []string{`{"index":1,"display":"Good","repo":"r/a","file":"a.gguf","size_gb":1}`}
	for i, f := range escapingFiles {
		rows = append(rows, fmt.Sprintf(`{"index":%d,"display":"Bad","repo":"r/b","file":%q,"size_gb":1}`, 40+i, f))
	}
	body := `{"schema_version":1,"models":[` + strings.Join(rows, ",") + `]}`
	cat, err := ParseRemote([]byte(body), "1.7.0")
	if err != nil {
		t.Fatalf("bad rows killed the whole remote list: %v", err)
	}
	if len(cat.Entries) != 1 {
		t.Errorf("got %d entries, want only the good one", len(cat.Entries))
	}
	for i, f := range escapingFiles {
		if _, ok := cat.Find(40 + i); ok {
			t.Errorf("remote entry with file %q was offered for download", f)
		}
	}
}
