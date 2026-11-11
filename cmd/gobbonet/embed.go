package main

import (
	"fmt"
	"io"
	"path/filepath"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/server"
	"github.com/ElodineOfficial/GobboNet/internal/supervisor"
)

// embedLogFile is the embedding server's own log, beside llama-server.log.
func embedLogFile(cfg config.Config) string {
	return filepath.Join(filepath.Dir(cfg.LogFile()), "embed-server.log")
}

// startEmbedding sets up the embedding server for serve (1.8.0, #15) and says
// what it did. Called after the chat model has booted, so a GPU the embedder is
// allowed onto is fitted to the chat model first.
//
// Up to 1.7.9 the launchers started it -- launch.bat on Windows, gobbonet-launch
// on Linux -- and nothing watched it. A Start-menu launch, which runs serve
// without launch.bat, started none at all.
func startEmbedding(w io.Writer, cfg config.Config, srv *server.Server, sup *supervisor.Supervisor) {
	switch server.EmbedRole(cfg, sup != nil) {
	case supervisor.EmbedOff:
		fmt.Fprintln(w, ` [OK] semantic search: off (embed_mode = "off"); RAG matches by tags`)
		return
	case supervisor.EmbedExternal:
		fmt.Fprintf(w, " [OK] embedding server: %s, not started by GobboNet\n", cfg.EmbedURL)
		return
	}
	path, pin, found := cfg.EmbedModelPath()
	e, err := supervisor.NewEmbedder(supervisor.EmbedOptions{
		ServerExe:        cfg.ServerExe,
		Model:            path,
		Pin:              pin,
		URL:              cfg.EmbedURL,
		Ctx:              cfg.EmbedCtx,
		GPULayers:        cfg.EmbedGPULayers,
		LogFile:          embedLogFile(cfg),
		ConsoleOut:       engineConsole(cfg),
		EngineOutputFull: cfg.EngineOutputFull,
	})
	if err != nil {
		fmt.Fprintf(w, " [!]  embedding server: %v\n", err)
		return
	}
	srv.AttachEmbedder(e)
	if found {
		where := "on the CPU"
		if cfg.EmbedGPULayers > 0 {
			where = fmt.Sprintf("%d layers on the GPU", cfg.EmbedGPULayers)
		}
		fmt.Fprintf(w, " [..] embedding server: starting %s at %s, %s\n", filepath.Base(path), cfg.EmbedURL, where)
	}
	// Started either way: without a model it says so once, on the console
	// ("[embed] failed: no embedding model at ...") and on
	// /health-fileserver, where the page shows it.
	e.Start()
}
