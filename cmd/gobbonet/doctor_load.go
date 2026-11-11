package main

import (
	"fmt"
	"io"
	"os"

	"github.com/ElodineOfficial/GobboNet/internal/supervisor"
)

// doctorLogTail is how much of llama-server.log doctor reads: the last run is
// at the end, and a load's own account is a few hundred lines at most.
const doctorLogTail = 256 << 10

// reportLastLoad says how the most recent model load went, from
// llama-server.log (1.8.0, #67). doctor runs on the PC with no session to ask
// the server, and the log is the engine's own account, so it is read here, and
// only the run after the last "starting llama-server" marker counts.
func reportLastLoad(w io.Writer, logPath string) {
	fmt.Fprintln(w, "LAST MODEL LOAD")
	text, err := readTail(logPath, doctorLogTail)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintln(w, "  (no engine log yet: no model has been started on this config)")
		} else {
			fmt.Fprintf(w, "  could not read %s: %v\n", logPath, err)
		}
		return
	}
	run := supervisor.LastRunInLog(text)
	if run.Model != "" {
		fmt.Fprintf(w, "  model:       %s\n", run.Model)
	}
	switch {
	case run.Loaded:
		fmt.Fprintln(w, "  result:      loaded (the engine was listening)")
	case run.Failure != nil:
		if advice := supervisor.CauseAdvice(run.Failure.Cause); advice != "" {
			fmt.Fprintf(w, "  result:      FAILED -- %s\n", advice)
		} else {
			fmt.Fprintln(w, "  result:      FAILED")
		}
		fmt.Fprintf(w, "  details:     %s\n", run.Failure.Line)
	case !run.HasLines:
		fmt.Fprintln(w, "  result:      started, nothing written yet (still loading, or stopped at once)")
	default:
		fmt.Fprintln(w, "  result:      unknown -- the engine did not say it was listening, nor why not")
	}
	if !run.Marked {
		fmt.Fprintln(w, "               (this log is from before 1.8.0, which did not mark where a run starts;")
		fmt.Fprintln(w, "               the result above may describe an older run)")
	}
	fmt.Fprintf(w, "  whole log:   %s\n", logPath)
}

// readTail returns up to the last n bytes of the file at path.
func readTail(path string, n int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	start := int64(0)
	if st.Size() > n {
		start = st.Size() - n
	}
	buf := make([]byte, st.Size()-start)
	if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
		return "", err
	}
	return string(buf), nil
}
