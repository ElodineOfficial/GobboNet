// Package updatetest is a fake GitHub release list for the update button's
// tests: releases with update files signed by a throwaway key, and the
// downloads they name, served from this machine.
package updatetest

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/update"
)

// Release is one release in the list.
type Release struct {
	Tag        string
	Prerelease bool
	Draft      bool
	// Manifest is signed and attached as gobbonet-update.json; nil attaches
	// no update file.
	Manifest *update.Manifest
	// RawManifest, when set, is attached instead of encoding Manifest.
	RawManifest []byte
	// SignWith signs with another key than the server's; BadSignature
	// attaches a signature of other bytes.
	SignWith     ed25519.PrivateKey
	BadSignature bool
	// Assets are the other files attached, by name.
	Assets map[string][]byte
	// SizeOverride reports an asset's size as this in the list.
	SizeOverride map[string]int64
}

// Server serves the list at /releases and the files at /download/<tag>/<name>.
type Server struct {
	*httptest.Server
	Key ed25519.PrivateKey
	Pub ed25519.PublicKey

	mu       sync.Mutex
	releases []Release
	hits     map[string]int
	// Status, when set, is the list's answer instead of 200.
	Status int
}

// New starts a server with a fresh key, closed with the test.
func New(t testing.TB, releases ...Release) *Server {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Key: priv, Pub: pub, releases: releases, hits: map[string]int{}}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.Close)
	return s
}

// SetReleases replaces the list.
func (s *Server) SetReleases(r ...Release) {
	s.mu.Lock()
	s.releases = r
	s.mu.Unlock()
}

// Hits is how often a path was asked for.
func (s *Server) Hits(path string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hits[path]
}

// ReleasesURL is the list's address, for update_releases_url.
func (s *Server) ReleasesURL() string { return s.URL + "/releases" }

// Checker asks this server, trusting its key.
func (s *Server) Checker() *update.Checker {
	return &update.Checker{ReleasesURL: s.ReleasesURL(), Keys: []ed25519.PublicKey{s.Pub},
		Client: update.GuardClient(s.Client(), s.ReleasesURL())}
}

// Client is the guarded client for downloads.
func (s *Server) GuardedClient() *http.Client {
	return update.GuardClient(s.Client(), s.ReleasesURL())
}

func (s *Server) manifestBytes(r Release) []byte {
	if r.RawManifest != nil {
		return r.RawManifest
	}
	raw, err := update.EncodeManifest(*r.Manifest)
	if err != nil {
		panic(err)
	}
	return raw
}

func (s *Server) files(r Release) map[string][]byte {
	out := map[string][]byte{}
	for k, v := range r.Assets {
		out[k] = v
	}
	if r.Manifest != nil || r.RawManifest != nil {
		raw := s.manifestBytes(r)
		out[update.ManifestName] = raw
		key := s.Key
		if r.SignWith != nil {
			key = r.SignWith
		}
		signed := raw
		if r.BadSignature {
			signed = append([]byte("not this "), raw...)
		}
		out[update.SignatureName] = []byte(update.Sign(key, signed))
	}
	return out
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.hits[r.URL.Path]++
	releases := append([]Release(nil), s.releases...)
	status := s.Status
	s.mu.Unlock()

	if r.URL.Path == "/releases" {
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		var list []update.Release
		for _, rel := range releases {
			out := update.Release{TagName: rel.Tag, Name: rel.Tag, Draft: rel.Draft, Prerelease: rel.Prerelease,
				HTMLURL: "https://github.com/ElodineOfficial/gobbonet/releases/tag/" + rel.Tag}
			for name, body := range s.files(rel) {
				size := int64(len(body))
				if o, ok := rel.SizeOverride[name]; ok {
					size = o
				}
				out.Assets = append(out.Assets, update.Asset{Name: name, Size: size, URL: s.URL + "/download/" + rel.Tag + "/" + name})
			}
			list = append(list, out)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)
		return
	}
	if rest, ok := strings.CutPrefix(r.URL.Path, "/download/"); ok {
		tag, name, _ := strings.Cut(rest, "/")
		for _, rel := range releases {
			if rel.Tag != tag {
				continue
			}
			if body, ok := s.files(rel)[name]; ok {
				w.Write(body)
				return
			}
		}
	}
	http.NotFound(w, r)
}

// Zip makes a ZIP of files, by path.
func Zip(files map[string][]byte) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		f, err := zw.Create(name)
		if err != nil {
			panic(err)
		}
		f.Write(body)
	}
	if err := zw.Close(); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// Sum is a SHA-256 in hex.
func Sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// ZipTarget is a target for a program inside a ZIP asset.
func ZipTarget(asset string, zipBytes []byte, member string, program []byte) update.Target {
	return update.Target{Asset: asset, Size: int64(len(zipBytes)), SHA256: Sum(zipBytes),
		Member: member, MemberSize: int64(len(program)), MemberSHA256: Sum(program)}
}

// Manifest is a valid update file for build ("1.8.1-go-abc1234") with one
// target.
func Manifest(build string, serial int64, key string, t update.Target) *update.Manifest {
	v := build
	if i := strings.Index(build, "-go-"); i > 0 {
		v = build[:i]
	}
	return &update.Manifest{Format: update.ManifestFormat, Product: update.Product, Version: v, Build: build,
		Serial: serial, Notes: "Test release " + build, Targets: map[string]update.Target{key: t}}
}
