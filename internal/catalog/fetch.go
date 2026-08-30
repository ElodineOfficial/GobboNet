package catalog

// Fetching the remote catalogue, with the precedence the roadmap sets:
//
//	fresh remote -> cached remote -> bundled models.ini
//
// A fetch failure must never block anything. Every step down that chain is a
// normal outcome, not an error path: offline installs, a down endpoint, and a
// user who switched the fetch off all have to end up with a working list.
//
// Privacy constraints, which are not negotiable for this app:
//
//   - Plain GET. No query parameters, no path parameters, no cookies, no
//     unique identifier of any kind. In particular the client does NOT send
//     its VRAM to get a tailored list — that is a hardware fingerprint. The
//     whole ~5 KB file is fetched and filtered locally.
//   - No version in the User-Agent. It is not unique to a person, but it is a
//     fingerprinting surface for no benefit the log of a static file needs.
//   - The browser is never involved. Go fetches; the page talks only to
//     localhost. That keeps the third-party origin out of the document.
//   - It is switchable off, and the setting is in the config panel rather
//     than buried.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// DefaultURL is the published catalogue endpoint.
//
// Deliberately the only place this string appears. Everything else takes it
// from config, which defaults to this.
const DefaultURL = "https://goblincorps.com/gobbonet_model_list.json"

// fetchTimeout is generous for a 5 KB file and short enough that a dead
// endpoint costs a click rather than a wait.
const fetchTimeout = 5 * time.Second

// maxBody caps what will be read. The real file is a few kilobytes; this is
// the difference between a bad response and an unbounded allocation.
const maxBody = 2 << 20 // 2 MB

// CacheMaxAge is how long a cached copy is served without asking again.
// Catalogue changes are measured in weeks, so re-fetching on every launch
// spends the user's network to learn nothing.
const CacheMaxAge = 24 * time.Hour

// Options configures a Fetch.
type Options struct {
	// URL of the remote catalogue. Empty means DefaultURL.
	URL string
	// Enabled reports whether the remote fetch may happen at all. When false,
	// Fetch goes straight to the cache and then the bundled file, and makes no
	// network request of any kind.
	Enabled bool
	// CacheDir is where the fetched copy is kept between runs.
	CacheDir string
	// BundledPath is models.ini, the last resort. Empty means Discover().
	BundledPath string
	// ClientVersion is checked against the catalogue's min_client.
	ClientVersion string
	// Force asks for the endpoint even when the cached copy is still inside
	// CacheMaxAge. Set when a user explicitly asks for the list -- opening the
	// add-a-model modal -- rather than on a background resolution.
	//
	// It skips the age check, not the conditional GET: the stored ETag and
	// Last-Modified still go out, so an unchanged catalogue costs a header
	// exchange rather than a transfer. Enabled=false still wins, because off
	// has to mean no request at all.
	Force bool
	// Client is the HTTP client to use. Nil means one with fetchTimeout.
	Client *http.Client
	// Now is injectable for tests. Nil means time.Now.
	Now func() time.Time
}

// cacheFile is the on-disk cache envelope. The raw body is kept verbatim
// rather than the parsed form so a later build with a wider parser can read an
// older cache, and so the validator runs on exactly what the server sent.
type cacheFile struct {
	FetchedAt    time.Time `json:"fetched_at"`
	ETag         string    `json:"etag,omitempty"`
	LastModified string    `json:"last_modified,omitempty"`
	Body         string    `json:"body"`
}

const cacheName = "model-catalog-cache.json"

// Fetch resolves a catalogue, trying each source in turn.
//
// It returns a catalogue whenever any source yields one. The error is returned
// only when every source failed, and the notes describe what happened at each
// step — those are for the log and the UI, not for control flow.
func Fetch(opts Options) (*Catalog, []string, error) {
	var notes []string
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}

	cached, cachedErr := readCache(opts.CacheDir)

	// 1. Fresh remote, unless it is switched off or the cache is still young.
	if opts.Enabled {
		fresh := opts.Force || cached == nil || now().Sub(cached.FetchedAt) >= CacheMaxAge
		if !fresh {
			notes = append(notes, "using the cached catalogue; it is less than a day old")
		} else {
			body, etag, lastMod, status, err := get(opts, cached)
			switch {
			case err != nil:
				notes = append(notes, "could not reach the catalogue: "+err.Error())
			case status == http.StatusNotModified && cached != nil:
				// Unchanged upstream. Re-stamp the cache so a server that keeps
				// answering 304 does not make us ask again every single run.
				cached.FetchedAt = now()
				_ = writeCache(opts.CacheDir, cached)
				notes = append(notes, "the catalogue is unchanged since it was last fetched")
			case status != http.StatusOK:
				notes = append(notes, fmt.Sprintf("the catalogue endpoint answered %d", status))
			default:
				cat, perr := ParseRemote(body, opts.ClientVersion)
				if perr != nil {
					// A served file that does not validate is exactly what the
					// fallback exists for. Do not cache it.
					notes = append(notes, perr.Error())
				} else {
					_ = writeCache(opts.CacheDir, &cacheFile{
						FetchedAt: now(), ETag: etag, LastModified: lastMod, Body: string(body),
					})
					return cat, notes, nil
				}
			}
		}
	} else {
		notes = append(notes, "the remote catalogue is switched off in settings")
	}

	// 2. Cached remote.
	if cached != nil {
		if cat, err := ParseRemote([]byte(cached.Body), opts.ClientVersion); err == nil {
			cat.Source = "cache"
			notes = append(notes, "using the last catalogue that was fetched successfully")
			return cat, notes, nil
		} else {
			notes = append(notes, "the cached catalogue no longer parses: "+err.Error())
		}
	} else if cachedErr != nil && !os.IsNotExist(cachedErr) {
		notes = append(notes, "could not read the cached catalogue: "+cachedErr.Error())
	}

	// 3. Bundled models.ini. Offline installs and a first run with no network
	//    both land here, and both must work.
	path := opts.BundledPath
	if path == "" {
		path = Discover()
	}
	if path == "" {
		return nil, notes, fmt.Errorf("no catalogue available: the remote fetch did not succeed and no models.ini was found")
	}
	cat, err := Load(path)
	if err != nil {
		return nil, notes, fmt.Errorf("no catalogue available: %w", err)
	}
	notes = append(notes, "using the model list that shipped with GobboNet")
	return cat, notes, nil
}

// get performs the conditional GET. Returns the body, the validators to store,
// and the status so the caller can distinguish 304 from a real failure.
func get(opts Options, cached *cacheFile) (body []byte, etag, lastMod string, status int, err error) {
	url := opts.URL
	if url == "" {
		url = DefaultURL
	}
	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: fetchTimeout}
	}

	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", "", 0, err
	}
	// A name, no version. See the privacy note at the top of this file.
	req.Header.Set("User-Agent", "GobboNet")
	req.Header.Set("Accept", "application/json")
	// Conditional GET, so an unchanged catalogue costs a header exchange
	// instead of a transfer.
	if cached != nil {
		if cached.ETag != "" {
			req.Header.Set("If-None-Match", cached.ETag)
		}
		if cached.LastModified != "" {
			req.Header.Set("If-Modified-Since", cached.LastModified)
		}
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", "", 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		return nil, resp.Header.Get("ETag"), resp.Header.Get("Last-Modified"), resp.StatusCode, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", "", resp.StatusCode, nil
	}

	body, err = io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, "", "", resp.StatusCode, err
	}
	return body, resp.Header.Get("ETag"), resp.Header.Get("Last-Modified"), resp.StatusCode, nil
}

func readCache(dir string) (*cacheFile, error) {
	if dir == "" {
		return nil, os.ErrNotExist
	}
	b, err := os.ReadFile(filepath.Join(dir, cacheName))
	if err != nil {
		return nil, err
	}
	var c cacheFile
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	if c.Body == "" {
		return nil, fmt.Errorf("the cached catalogue is empty")
	}
	return &c, nil
}

func writeCache(dir string, c *cacheFile) error {
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	// Write-and-rename: a crash mid-write must not leave a truncated cache that
	// then fails to parse on every subsequent run.
	tmp := filepath.Join(dir, cacheName+".tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, cacheName))
}
