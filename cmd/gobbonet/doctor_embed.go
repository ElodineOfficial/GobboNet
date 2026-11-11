package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/server"
)

// reportEmbedding says who runs the embedding server, whether its model is
// there and matches its pin, and whether anything answers (1.8.0, #15).
func reportEmbedding(w io.Writer, cfg config.Config) {
	fmt.Fprintln(w, "EMBEDDING SERVER (semantic search)")
	role := server.EmbedRole(cfg, cfg.ServerExe != "")
	switch role {
	case "off":
		fmt.Fprintln(w, `  mode:        off (embed_mode = "off"); RAG matches by tags only`)
		return
	case "external":
		why := "embed_mode = \"external\""
		if cfg.EmbedMode == config.EmbedManaged {
			why = "managed, but there is no local engine or embed_url is not on this PC"
		}
		fmt.Fprintf(w, "  mode:        external (%s)\n", why)
	default:
		fmt.Fprintln(w, "  mode:        managed: GobboNet starts it, restarts it if it crashes, and")
		fmt.Fprintln(w, "               stands it down with the chat model")
		path, pin, found := cfg.EmbedModelPath()
		if !found {
			fmt.Fprintf(w, "  model:       MISSING -- expected at %s\n", path)
			fmt.Fprintln(w, "               Semantic search stays off until it is there. The Windows first run")
			fmt.Fprintln(w, "               (launch.bat) and the Linux setup wizard download it.")
		} else {
			fmt.Fprintf(w, "  model:       %s\n", path)
			switch got, err := hashFile(path); {
			case pin == "":
				fmt.Fprintln(w, "  checksum:    not checked (a model of your own, set in embed_model)")
			case err != nil:
				fmt.Fprintf(w, "  checksum:    could not read it: %v\n", err)
			case got == pin:
				fmt.Fprintln(w, "  checksum:    matches its pin")
			default:
				fmt.Fprintf(w, "  checksum:    DOES NOT MATCH its pin (expected %s, got %s)\n", pin[:12], got[:12])
				fmt.Fprintln(w, "               GobboNet will not start it. Delete it and run setup again.")
			}
		}
		fmt.Fprintf(w, "  log:         %s\n", embedLogFile(cfg))
	}
	client := &http.Client{Timeout: 2 * time.Second}
	if resp, err := client.Get(cfg.EmbedURL + "/health"); err == nil {
		resp.Body.Close()
		fmt.Fprintf(w, "  answering:   yes, at %s (HTTP %d)\n", cfg.EmbedURL, resp.StatusCode)
	} else if role == "managed" {
		fmt.Fprintf(w, "  answering:   no, at %s -- it runs while GobboNet does\n", cfg.EmbedURL)
	} else {
		fmt.Fprintf(w, "  answering:   no, at %s\n", cfg.EmbedURL)
	}
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
