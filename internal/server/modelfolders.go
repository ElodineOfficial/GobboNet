package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/httpx"
)

// /model-folders (1.8.0, issue #68): CONFIG > Model & Performance > Model
// Folders. Three config.toml keys that could only be changed in the Config
// File editor until now:
//
//	model_dir      the models folder: what the model menu lists, where
//	               downloads land and where Found on this computer links to
//	model_dirs     extra folders Add a Model > Found on this computer reads
//	scan_hf_cache  whether it reads the HuggingFace cache too
//
// ONLY FROM THIS PC, as the Config File editor is (fromThisPC, configfile.go).
// model_dir decides where GobboNet writes files and model_dirs which of this
// PC's folders it reads, so a phone, or someone holding a session cookie read
// off the LAN, is told where to change them and sent no paths.
//
// Saved for the next start. The model menu, the engine and downloads all hold
// model_dir from start-up; switching it under a loaded model would leave them
// looking in two places. GET reads config.toml, so a saved change shows as
// saved, and says a restart is still to come.

const maxModelDirs = 32

type modelFoldersView struct {
	Editable      bool     `json:"editable"`
	Reason        string   `json:"reason,omitempty"`
	ModelDir      string   `json:"model_dir,omitempty"`
	ModelDirs     []string `json:"model_dirs"`
	ScanHFCache   bool     `json:"scan_hf_cache"`
	RestartNeeded bool     `json:"restart_needed"`
	EnvOverride   string   `json:"env_override,omitempty"`
	Saved         bool     `json:"saved,omitempty"`
}

func (s *Server) handleModelFolders(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET or POST only")
		return
	}
	write := r.Method == http.MethodPost
	if !sameOriginStrict(r, write) {
		httpx.Error(w, r, http.StatusForbidden, "Change the model folders from GobboNet's own CONFIG panel.")
		return
	}
	if !fromThisPC(r) {
		if write {
			httpx.Error(w, r, http.StatusForbidden, "The model folders can only be changed from the PC GobboNet runs on.")
			return
		}
		port := s.cfg.ListenPort
		if b := s.Bind(); b != nil {
			port = b.Port
		}
		httpx.WriteJSON(w, r, http.StatusOK, modelFoldersView{
			ModelDirs: []string{},
			Reason: fmt.Sprintf("The model folders can only be changed from the PC GobboNet runs on, at http://127.0.0.1:%d. "+
				"They decide where GobboNet saves files on that PC, so they are not offered to other devices.", port),
		})
		return
	}
	if s.cfg.Path == "" {
		httpx.WriteJSON(w, r, http.StatusOK, modelFoldersView{ModelDirs: []string{},
			Reason: "This server was started without a config file, so there is nowhere to save these."})
		return
	}
	if !write {
		view, err := s.modelFoldersNow()
		if err != nil {
			log.Printf("[model-folders] could not read %s: %v", s.cfg.Path, err)
			httpx.Error(w, r, http.StatusInternalServerError, "config.toml could not be read, so the model folders cannot be shown.")
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, view)
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "could not read body")
		return
	}
	var in struct {
		ModelDir    *string   `json:"model_dir"`
		ModelDirs   *[]string `json:"model_dirs"`
		ScanHFCache *bool     `json:"scan_hf_cache"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "body must be JSON: {model_dir, model_dirs, scan_hf_cache}")
		return
	}
	file, err := config.Load(s.cfg.Path)
	if err != nil {
		log.Printf("[model-folders] could not read %s: %v", s.cfg.Path, err)
		httpx.Error(w, r, http.StatusInternalServerError, "config.toml could not be read, so nothing was changed.")
		return
	}

	// Check all of it before writing any of it.
	type change struct{ key, value string }
	var changes []change
	if in.ModelDir != nil {
		dir, err := cleanFolder(*in.ModelDir, "the models folder")
		if err != nil {
			httpx.Error(w, r, http.StatusBadRequest, err.Error())
			return
		}
		if !samePathFold(dir, file.ModelDir) {
			if err := usableModelsFolder(dir); err != nil {
				httpx.Error(w, r, http.StatusBadRequest, err.Error())
				return
			}
			changes = append(changes, change{"model_dir", dir})
		}
	}
	if in.ModelDirs != nil {
		dirs, err := cleanFolderList(*in.ModelDirs)
		if err != nil {
			httpx.Error(w, r, http.StatusBadRequest, err.Error())
			return
		}
		if !sameStrings(dirs, file.ModelDirs) {
			list, _ := json.Marshal(dirs)
			changes = append(changes, change{"model_dirs", string(list)})
		}
	}
	if in.ScanHFCache != nil && *in.ScanHFCache != file.ScanHFCache {
		changes = append(changes, change{"scan_hf_cache", strconv.FormatBool(*in.ScanHFCache)})
	}
	for _, c := range changes {
		if err := config.Set(s.cfg.Path, c.key, c.value); err != nil {
			log.Printf("[model-folders] could not save %s to %s: %v", c.key, s.cfg.Path, err)
			httpx.Error(w, r, http.StatusInternalServerError, "config.toml could not be written, so "+c.key+" was not changed.")
			return
		}
	}
	if len(changes) > 0 {
		log.Printf("[model-folders] saved %d change(s) to %s; they apply from the next start", len(changes), s.cfg.Path)
	}
	view, err := s.modelFoldersNow()
	if err != nil {
		httpx.Error(w, r, http.StatusInternalServerError, "Saved, but config.toml could not be read back.")
		return
	}
	view.Saved = len(changes) > 0
	httpx.WriteJSON(w, r, http.StatusOK, view)
}

// modelFoldersNow is what config.toml says now, against what this process
// started with.
func (s *Server) modelFoldersNow() (modelFoldersView, error) {
	file, err := config.Load(s.cfg.Path)
	if err != nil {
		return modelFoldersView{}, err
	}
	dirs := file.ModelDirs
	if dirs == nil {
		dirs = []string{}
	}
	v := modelFoldersView{
		Editable:    true,
		ModelDir:    file.ModelDir,
		ModelDirs:   dirs,
		ScanHFCache: file.ScanHFCache,
		RestartNeeded: !samePathFold(file.ModelDir, s.cfg.ModelDir) ||
			!sameStrings(file.ModelDirs, s.cfg.ModelDirs) || file.ScanHFCache != s.cfg.ScanHFCache,
	}
	for _, name := range []string{"GOBBONET_MODEL_DIR", "GEMMA_MODEL_DIR"} {
		if os.Getenv(name) != "" {
			v.EnvOverride = name
			break
		}
	}
	return v, nil
}

// cleanFolder accepts an absolute folder, or one under ~, and returns it
// absolute and clean.
func cleanFolder(raw, what string) (string, error) {
	p := strings.TrimSpace(raw)
	if p == "" {
		return "", fmt.Errorf("Choose %s.", what)
	}
	if err := plainPath(p, what); err != nil {
		return "", err
	}
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("%s starts with ~, but this PC has no home folder to expand it to.", upperFirst(what))
		}
		p = filepath.Join(home, p[1:])
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("Give %s as a full path, such as %s.", what, exampleFolder())
	}
	return filepath.Clean(p), nil
}

// cleanFolderList checks model_dirs. Folders are kept as written (a ~ stays a
// ~, internal/localmodels expands it), and need not exist: a drive that is
// unplugged today is still worth looking in tomorrow.
func cleanFolderList(raw []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, d := range raw {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		if err := plainPath(d, "an extra folder"); err != nil {
			return nil, err
		}
		if !(d == "~" || strings.HasPrefix(d, "~/") || strings.HasPrefix(d, `~\`) || filepath.IsAbs(d)) {
			return nil, fmt.Errorf("%q is not a full path. Give each extra folder as a full path, such as %s.", d, exampleFolder())
		}
		key := d
		if runtime.GOOS == "windows" {
			key = strings.ToLower(d)
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, d)
	}
	if len(out) > maxModelDirs {
		return nil, fmt.Errorf("That is %d extra folders; %d is the most GobboNet will look in.", len(out), maxModelDirs)
	}
	return out, nil
}

func plainPath(p, what string) error {
	if len(p) > 4096 {
		return fmt.Errorf("%s is too long to be a folder path.", upperFirst(what))
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%s has a control character in it.", upperFirst(what))
		}
	}
	return nil
}

// usableModelsFolder makes sure downloads will have somewhere to go: the
// folder is created if it is missing (0700, as setup does) and write-tested.
// Nothing already in it is touched.
func usableModelsFolder(dir string) error {
	if st, err := os.Stat(dir); err == nil && !st.IsDir() {
		return fmt.Errorf("%s is a file, not a folder.", dir)
	} else if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("GobboNet could not create %s: %v", dir, unwrapPathErr(err))
		}
	}
	f, err := os.CreateTemp(dir, ".gobbonet-write-test-*")
	if err != nil {
		return fmt.Errorf("GobboNet cannot write to %s (%v), and downloads go there. Choose a folder you own.", dir, unwrapPathErr(err))
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return nil
}

func unwrapPathErr(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

func samePathFold(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func upperFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func exampleFolder() string {
	if runtime.GOOS == "windows" {
		return `D:\Models`
	}
	return "/home/you/models"
}
