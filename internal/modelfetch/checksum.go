package modelfetch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/catalog"
)

// hashingCopy copies src to dst, hashing every byte on the way past, and
// returns the SHA-256 as lowercase hex. The one hasher a download and CHECK
// FILE share (1.8.0, #67): it used to live inside Run, so nothing else could
// verify a model that was already on disk.
func hashingCopy(dst io.Writer, src io.Reader) (written int64, sum string, err error) {
	h := sha256.New()
	written, err = io.Copy(io.MultiWriter(dst, h), src)
	return written, hex.EncodeToString(h.Sum(nil)), err
}

// HashFile reads the file at path once and returns its SHA-256 as lowercase
// hex. progress, if not nil, is called with the bytes read so far and the
// file's size, at most a few times a second. ctx stops it between reads.
func HashFile(ctx context.Context, path string, progress func(done, total int64)) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file", st.Name())
	}
	var done atomic.Int64
	stop := make(chan struct{})
	if progress != nil {
		go func() {
			t := time.NewTicker(250 * time.Millisecond)
			defer t.Stop()
			for {
				select {
				case <-stop:
					return
				case <-t.C:
					progress(done.Load(), st.Size())
				}
			}
		}()
	}
	_, sum, err := hashingCopy(io.Discard, ctxReader{ctx: ctx, r: countingReader{r: f, n: &done}})
	close(stop)
	if progress != nil {
		progress(done.Load(), st.Size())
	}
	return sum, err
}

type countingReader struct {
	r io.Reader
	n *atomic.Int64
}

func (c countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// fetchPointerSum reads the SHA-256 HuggingFace records for a file, from its
// LFS pointer at url. An error says why there is none.
func fetchPointerSum(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HuggingFace answered %s", resp.Status)
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if m := lfsOID.FindSubmatch(body); m != nil {
		return strings.ToLower(string(m[1])), nil
	}
	return "", fmt.Errorf("HuggingFace's record for this file holds no checksum")
}

// PointerSum asks HuggingFace for the checksum it records for e's file. It is
// a request to huggingface.co, so CHECK FILE makes it only when the user
// clicks "Ask HuggingFace"; the catalogue's own pin needs no network at all.
// hostBase replaces https://huggingface.co in tests and is "" otherwise.
func PointerSum(ctx context.Context, e catalog.Entry, hostBase string) (string, error) {
	url := e.PointerURL()
	if hostBase != "" {
		url = hostBase + "/" + e.Repo + "/raw/main/" + e.File
	}
	return fetchPointerSum(ctx, url)
}
