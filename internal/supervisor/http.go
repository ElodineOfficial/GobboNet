package supervisor

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/ElodineOfficial/GobboNet/internal/httpx"
)

// NotConfiguredMessage is what remote mode reports. Not an invention: it is the
// exact path the 1.7 PowerShell server took whenever launch.bat had not handed it a server
// executable, and chat.html already renders it as a disabled swap control rather
// than an error.
const NotConfiguredMessage = "Model swapping needs this machine to run llama.cpp itself. " +
	"Set server_exe in config.toml, or change the model on the server llm_url points at."

// Handlers serves /swap-model and /swap-status. A nil Supervisor means remote
// mode, where both routes answer honestly rather than pretending.
type Handlers struct {
	Sup *Supervisor
}

// HandleSwapModel serves POST /swap-model with body {"file":"<name>.gguf"}.
// Returns 202 immediately; the client polls /swap-status for the outcome.
func (h Handlers) HandleSwapModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteJSON(w, r, http.StatusMethodNotAllowed, map[string]string{
			"phase": PhaseError, "message": "POST only",
		})
		return
	}
	if h.Sup == nil {
		httpx.WriteJSON(w, r, http.StatusServiceUnavailable, map[string]string{
			"phase": PhaseError, "message": NotConfiguredMessage,
		})
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{
			"phase": PhaseError, "message": "could not read request body",
		})
		return
	}
	var req struct {
		File string `json:"file"`
		// Auto marks a switch the page makes on its own (1.8.0, #52). It is
		// refused with 409 and "busy": true while any reply is being written.
		Auto bool `json:"auto"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.File == "" {
		httpx.WriteJSON(w, r, http.StatusBadRequest, map[string]string{
			"phase": PhaseError, "message": `expected {"file":"<name>.gguf"}`,
		})
		return
	}

	swap := h.Sup.Swap
	if req.Auto {
		swap = h.Sup.SwapAuto
	}
	if err := swap(req.File); err != nil {
		if err == ErrBusy {
			// Not an error phase: nothing went wrong, and the model that is
			// loaded stays loaded. The page waits and asks again.
			httpx.WriteJSON(w, r, http.StatusConflict, map[string]any{
				"phase": h.Sup.Status().Phase, "message": err.Error(), "busy": true,
			})
			return
		}
		status := http.StatusBadRequest
		if err == ErrSwapInFlight {
			status = http.StatusConflict
		}
		httpx.WriteJSON(w, r, status, map[string]string{
			"phase": PhaseError, "message": err.Error(),
		})
		return
	}

	httpx.WriteJSON(w, r, http.StatusAccepted, h.Sup.Status())
}

// HandleSwapStatus serves GET /swap-status.
func (h Handlers) HandleSwapStatus(w http.ResponseWriter, r *http.Request) {
	if h.Sup == nil {
		// Remote mode has nothing in flight, ever. chat.html treats idle as
		// "no swap happening", which is the truth.
		httpx.WriteJSON(w, r, http.StatusOK, map[string]string{"phase": PhaseIdle})
		return
	}
	httpx.WriteJSON(w, r, http.StatusOK, h.Sup.Status())
}
