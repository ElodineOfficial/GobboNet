package modelfetch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/catalog"
)

// CHECK FILE (1.8.0, #67): the hasher a download uses, on a file already there.

func TestHashFileIsTheFilesSHA256(t *testing.T) {
	data := []byte(strings.Repeat("GGUF and then some weights ", 200000)) // ~5 MB
	path := filepath.Join(t.TempDir(), "m.gguf")
	os.WriteFile(path, data, 0o600)
	want := sha256.Sum256(data)

	var mu sync.Mutex
	var last [2]int64
	got, err := HashFile(context.Background(), path, func(done, total int64) {
		mu.Lock()
		last = [2]int64{done, total}
		mu.Unlock()
	})
	if err != nil || got != hex.EncodeToString(want[:]) {
		t.Fatalf("HashFile = %q, %v", got, err)
	}
	if last[0] != int64(len(data)) || last[1] != int64(len(data)) {
		t.Errorf("last progress = %v, want the whole file", last)
	}
}

func TestHashFileStopsWhenAsked(t *testing.T) {
	path := filepath.Join(t.TempDir(), "m.gguf")
	os.WriteFile(path, make([]byte, 1<<20), 0o600)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := HashFile(ctx, path, nil); err == nil {
		t.Error("a cancelled check finished anyway")
	}
	if _, err := HashFile(context.Background(), filepath.Dir(path), nil); err == nil {
		t.Error("a folder was hashed as a model")
	}
}

// The download and CHECK FILE agree, because they are the same code.
func TestDownloadAndCheckShareTheHasher(t *testing.T) {
	_, sum, err := hashingCopy(&strings.Builder{}, strings.NewReader("abc"))
	if err != nil || sum != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Errorf("hashingCopy(abc) = %q, %v", sum, err)
	}
	src, _ := os.ReadFile("download.go")
	if strings.Contains(string(src), "sha256.New()") || !strings.Contains(string(src), "hashingCopy(") {
		t.Error("Run hashes on its own again instead of through hashingCopy")
	}
}

func TestPointerSumAsksOnlyTheAddressGiven(t *testing.T) {
	const oid = "3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7"
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "/gone.gguf") {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("version https://git-lfs.github.com/spec/v1\noid sha256:" + strings.ToUpper(oid) + "\nsize 123\n"))
	}))
	defer srv.Close()
	e := catalog.Entry{Repo: "org/repo", File: "m.gguf"}
	got, err := PointerSum(context.Background(), e, srv.URL)
	if err != nil || got != oid {
		t.Fatalf("PointerSum = %q, %v", got, err)
	}
	if len(asked) != 1 || asked[0] != "/org/repo/raw/main/m.gguf" {
		t.Errorf("asked %v, want one request for the file's pointer", asked)
	}
	if _, err := PointerSum(context.Background(), catalog.Entry{Repo: "org/repo", File: "gone.gguf"}, srv.URL); err == nil ||
		!strings.Contains(err.Error(), "404") {
		t.Errorf("a missing record: %v", err)
	}
}
