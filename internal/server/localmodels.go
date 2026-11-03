package server

// GET  /local-models.json   models already on this computer (1.7.9, issue #12)
// POST /local-models/link   link one into the models folder: {"id": "..."}
//
// Add a Model's "Found on this computer". See internal/localmodels for why it
// links rather than copies, and why the models folder stays the only place
// the rest of GobboNet looks.
//
// Behind the auth gate with everything else: the scan lists file paths on
// this machine, and the link writes into the models folder.
//
// The browser sends back an ID the scan handed it, never a path. Link
// re-scans and resolves the ID itself, so the only things that can be linked
// are .gguf files the scan would offer from the configured roots.

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"

	"github.com/ElodineOfficial/GobboNet/internal/httpx"
	"github.com/ElodineOfficial/GobboNet/internal/localmodels"
)

func (s *Server) localRoots() []localmodels.Root {
	home, _ := os.UserHomeDir()
	return localmodels.Roots(s.cfg.ModelDirs, s.cfg.ScanHFCache, os.Getenv, home)
}

type localModelRow struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	File   string  `json:"file"`
	SizeGB float64 `json:"sizeGB"`
	Parts  int     `json:"parts"`
	Repo   string  `json:"repo,omitempty"`
	Kind   string  `json:"kind"`
	Where  string  `json:"where"`
	State  string  `json:"state"`
}

func (s *Server) handleLocalModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET only")
		return
	}
	roots := s.localRoots()
	found, notes := localmodels.Scan(roots, s.modelDir(), localmodels.Limits{})
	rows := make([]localModelRow, 0, len(found))
	for _, f := range found {
		rows = append(rows, localModelRow{
			ID: f.ID, Name: f.Name, File: f.File, Parts: f.PartCount,
			SizeGB: float64(f.SizeBytes) / (1 << 30),
			Repo:   f.Repo, Kind: f.Kind, Where: f.Root, State: f.State,
		})
	}
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"roots":    roots,
		"found":    rows,
		"notes":    nonNil(notes),
		"modelDir": s.modelDir(),
	})
}

func (s *Server) handleLocalModelLink(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<10))
	if err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "could not read body")
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.ID == "" {
		httpx.Error(w, r, http.StatusBadRequest, "Body must be {\"id\": \"...\"}.")
		return
	}
	found, _ := localmodels.Scan(s.localRoots(), s.modelDir(), localmodels.Limits{})
	var pick *localmodels.Found
	for i := range found {
		if found[i].ID == req.ID {
			pick = &found[i]
			break
		}
	}
	if pick == nil {
		httpx.Error(w, r, http.StatusNotFound,
			"That model is no longer where it was found. Close Add a Model and open it again.")
		return
	}
	how, err := localmodels.Link(*pick, s.modelDir())
	if err != nil {
		code := http.StatusInternalServerError
		if errors.Is(err, localmodels.ErrNameTaken) {
			code = http.StatusConflict
		}
		httpx.Error(w, r, code, err.Error())
		return
	}
	log.Printf("[models] linked %s into the models folder from %s (%s)", pick.File, pick.Root, how)
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"linked": true,
		"file":   pick.File,
		"how":    how,
	})
}
