package update

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultReleasesURL is GitHub's list of GobboNet releases. Deliberately the
// only place it appears; config.toml's update_releases_url defaults to it.
const DefaultReleasesURL = "https://api.github.com/repos/ElodineOfficial/gobbonet/releases?per_page=20"

// ReleasesPage is where a person downloads a release by hand.
const ReleasesPage = "https://github.com/ElodineOfficial/gobbonet/releases"

// maxCandidates is how many releases' update files one check reads, newest
// first. A hotfix is a new release or a re-upload to the current one, so the
// newest few always include it.
const maxCandidates = 5

// maxReleaseListBytes caps the release list. Each release carries its notes,
// which are the bulk of it.
const maxReleaseListBytes = 8 << 20

// Release is the part of a GitHub release this uses.
type Release struct {
	TagName     string  `json:"tag_name"`
	Name        string  `json:"name"`
	Draft       bool    `json:"draft"`
	Prerelease  bool    `json:"prerelease"`
	HTMLURL     string  `json:"html_url"`
	PublishedAt string  `json:"published_at"`
	Assets      []Asset `json:"assets"`
}

// Asset is one file attached to a release.
type Asset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
}

func (r Release) asset(name string) (Asset, bool) {
	for _, a := range r.Assets {
		if a.Name == name {
			return a, true
		}
	}
	return Asset{}, false
}

// Offer is a release this build may update to.
type Offer struct {
	Manifest Manifest
	// Release is the GitHub release the update file came from.
	Tag     string
	PageURL string
	// TargetKey and Target are this platform's download, and Asset where it
	// is; all empty when the release has nothing for this platform.
	TargetKey string
	Target    Target
	Asset     Asset
}

// Result is one check.
type Result struct {
	Current Build
	// Offer is the release to update to, or nil when this build is current.
	Offer *Offer
	// Newest is the newest published release, whatever it carries. Only for
	// a build that cannot verify anything (no trusted key), to say where to
	// look; its tag is not checked by anything.
	NewestTag  string
	NewestPage string
	// Notes are releases skipped and why, for the page to mention.
	Notes   []string
	Checked time.Time
}

// Checker asks a release list for a newer build.
type Checker struct {
	// ReleasesURL is GitHub's release list, or one shaped like it.
	ReleasesURL string
	Keys        []ed25519.PublicKey
	// Client is replaced in tests; nil means one built by NewClient.
	Client *http.Client
}

// ErrOff is a check with no release list to ask.
var ErrOff = errors.New("update checks are switched off: update_releases_url is empty in config.toml")

// Check asks for the release list and picks the best build this one may
// update to. target is this install's platform key (Place.Target); offers
// are made without one too, to say a release exists that cannot be
// installed here.
func (c *Checker) Check(ctx context.Context, cur Build, target string) (*Result, error) {
	res := &Result{Current: cur, Checked: time.Now()}
	if strings.TrimSpace(c.ReleasesURL) == "" {
		return res, ErrOff
	}
	client := c.Client
	if client == nil {
		var err error
		if client, err = NewClient(c.ReleasesURL); err != nil {
			return res, err
		}
	}
	releases, err := c.fetchReleases(ctx, client)
	if err != nil {
		return res, err
	}

	var published []Release
	for _, r := range releases {
		if r.Draft || r.Prerelease {
			continue
		}
		published = append(published, r)
		if res.NewestTag == "" {
			res.NewestTag, res.NewestPage = r.TagName, r.HTMLURL
		}
	}
	if len(c.Keys) == 0 {
		res.Notes = append(res.Notes, ErrNoTrustedKeys.Error())
		return res, nil
	}

	var best *Offer
	seen := 0
	for _, r := range published {
		if seen >= maxCandidates {
			break
		}
		mAsset, ok1 := r.asset(ManifestName)
		sAsset, ok2 := r.asset(SignatureName)
		if !ok1 || !ok2 {
			continue
		}
		seen++
		m, err := c.readManifest(ctx, client, mAsset, sAsset)
		if err != nil {
			res.Notes = append(res.Notes, fmt.Sprintf("%s: %v", r.TagName, err))
			continue
		}
		if !Newer(cur, m.Of()) {
			continue
		}
		offer := &Offer{Manifest: m, Tag: r.TagName, PageURL: r.HTMLURL}
		if t, ok := m.Targets[target]; ok && target != "" {
			a, found := r.asset(t.Asset)
			switch {
			case !found:
				res.Notes = append(res.Notes, fmt.Sprintf("%s: the update file names %s, which is not attached to the release", r.TagName, t.Asset))
			case a.Size != t.Size:
				res.Notes = append(res.Notes, fmt.Sprintf("%s: %s is %d bytes on GitHub but the update file says %d", r.TagName, t.Asset, a.Size, t.Size))
			default:
				offer.TargetKey, offer.Target, offer.Asset = target, t, a
			}
		}
		// The best release that can be installed here beats a better one
		// that cannot; between two alike, the later build.
		switch {
		case best == nil:
			best = offer
		case (offer.TargetKey != "") != (best.TargetKey != ""):
			if offer.TargetKey != "" {
				best = offer
			}
		case Better(offer.Manifest.Of(), best.Manifest.Of()):
			best = offer
		}
	}
	res.Offer = best
	return res, nil
}

func (c *Checker) fetchReleases(ctx context.Context, client *http.Client) ([]Release, error) {
	body, status, err := get(ctx, client, c.ReleasesURL, maxReleaseListBytes, "application/vnd.github+json")
	if err != nil {
		return nil, fmt.Errorf("could not reach the release list: %v", err)
	}
	switch {
	case status == http.StatusForbidden || status == http.StatusTooManyRequests:
		return nil, errors.New("GitHub is limiting how often this network can ask for the release list. Try again in an hour")
	case status == http.StatusNotFound:
		return nil, fmt.Errorf("no release list at %s", redact(c.ReleasesURL))
	case status != http.StatusOK:
		return nil, fmt.Errorf("the release list answered HTTP %d", status)
	}
	var releases []Release
	if err := json.Unmarshal(body, &releases); err != nil {
		return nil, errors.New("the release list is not in GitHub's format")
	}
	return releases, nil
}

func (c *Checker) readManifest(ctx context.Context, client *http.Client, mAsset, sAsset Asset) (Manifest, error) {
	if mAsset.Size > maxManifestBytes || sAsset.Size > maxSignatureBytes {
		return Manifest{}, errors.New("the update file is too large")
	}
	sig, status, err := get(ctx, client, sAsset.URL, maxSignatureBytes, "")
	if err != nil || status != http.StatusOK {
		return Manifest{}, fmt.Errorf("could not download %s (%s)", SignatureName, failure(status, err))
	}
	raw, status, err := get(ctx, client, mAsset.URL, maxManifestBytes, "")
	if err != nil || status != http.StatusOK {
		return Manifest{}, fmt.Errorf("could not download %s (%s)", ManifestName, failure(status, err))
	}
	if err := Verify(raw, sig, c.Keys); err != nil {
		return Manifest{}, err
	}
	return ParseManifest(raw)
}

func failure(status int, err error) string {
	if err != nil {
		return err.Error()
	}
	return fmt.Sprintf("HTTP %d", status)
}

// get is one bounded GET. A body over max is an error rather than a cut.
func get(ctx context.Context, client *http.Client, u string, max int64, accept string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	setHeaders(req, accept)
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, resp.StatusCode, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if int64(len(body)) > max {
		return nil, resp.StatusCode, errors.New("the response is larger than expected")
	}
	return body, resp.StatusCode, nil
}

// setHeaders is the whole of what a request says. No version and nothing
// about the install, the same rule as the model catalogue's fetch
// (internal/catalog/fetch.go): GitHub requires a User-Agent, and the product
// name is all it gets.
func setHeaders(req *http.Request, accept string) {
	req.Header.Set("User-Agent", "GobboNet")
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
}

// --- where requests may go --------------------------------------------------

// githubHosts are the hosts GitHub serves releases from: the API, the
// download links, and the storage those redirect to.
var githubHosts = []string{"api.github.com", "github.com"}

func hostAllowed(host string, extra string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, h := range githubHosts {
		if host == h {
			return true
		}
	}
	if strings.HasSuffix(host, ".githubusercontent.com") {
		return true
	}
	return extra != "" && host == extra
}

func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// allowedURL is where any request in a check or a download may go: GitHub,
// over https, or the host of update_releases_url itself, so that a mirror of
// the list works. Plain http only to this machine, which is what tests and a
// local mirror use.
func allowedURL(raw, extraHost string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("%q is not an address", redact(raw))
	}
	host := strings.ToLower(u.Hostname())
	if !hostAllowed(host, extraHost) {
		return fmt.Errorf("%s is not GitHub or the host of update_releases_url, so nothing is fetched from it", host)
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if loopbackHost(host) {
			return nil
		}
	}
	return fmt.Errorf("%s is not an https address", redact(raw))
}

// NewClient is the client every check and download goes through. Each
// request, and each redirect it is sent to, must pass allowedURL; the
// timeouts bound the parts that should be quick, and the body of a download
// is bounded by stallTimeout in install.go.
func NewClient(releasesURL string) (*http.Client, error) {
	extra := ""
	if u, err := url.Parse(releasesURL); err == nil {
		extra = strings.ToLower(u.Hostname())
	}
	if err := allowedURL(releasesURL, extra); err != nil {
		return nil, fmt.Errorf("update_releases_url: %v", err)
	}
	return &http.Client{
		Transport: &guardedTransport{extra: extra, next: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   20 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			ForceAttemptHTTP2:     true,
			IdleConnTimeout:       60 * time.Second,
		}},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			return allowedURL(req.URL.String(), extra)
		},
	}, nil
}

// GuardClient wraps a test server's client in the same rules.
func GuardClient(c *http.Client, releasesURL string) *http.Client {
	extra := ""
	if u, err := url.Parse(releasesURL); err == nil {
		extra = strings.ToLower(u.Hostname())
	}
	next := c.Transport
	if next == nil {
		next = http.DefaultTransport
	}
	return &http.Client{
		Transport: &guardedTransport{extra: extra, next: next},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			return allowedURL(req.URL.String(), extra)
		},
		Timeout: c.Timeout,
	}
}

// guardedTransport refuses a request to anywhere allowedURL does not allow.
// On the transport rather than only in CheckRedirect, so the first request is
// held to it as well as every hop after.
type guardedTransport struct {
	extra string
	next  http.RoundTripper
}

func (g *guardedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := allowedURL(req.URL.String(), g.extra); err != nil {
		return nil, err
	}
	return g.next.RoundTrip(req)
}

// redact drops a query string, which is where a token in a mirror's address
// would be.
func redact(raw string) string {
	if i := strings.IndexByte(raw, '?'); i >= 0 {
		return raw[:i]
	}
	return raw
}
