package supervisor

import (
	"os/exec"
	"sync"
)

// Child is a program GobboNet starts and owns that is not an engine: an MCP
// server (1.8.0, #16). It gets the same process handling the engines get --
// its own process group, the Windows job that ends it when gobbonet dies, and
// a sweep of the whole group on Stop -- through spawnTree and endTree, so
// there is still one way to launch and one way to stop. What it does not get
// is a state machine: an MCP server's restarts are its owner's business
// (internal/mcp restarts one lazily, on the next call that needs it).
type Child struct {
	cmd       *exec.Cmd
	pgid      int
	tag, what string
	exited    chan struct{}
	waitErr   error

	stopOnce sync.Once
	stopErr  error
}

// StartChild starts cmd as the head of its own process group, tied to this
// process's lifetime. Set cmd's stdio before calling. tag prefixes log lines
// ("[mcp:files]") and what names the program in them.
//
// Give cmd *os.File stdio (os.Pipe ends, a log file) rather than an
// io.Writer: Wait then only waits for the process, never for a copy, so
// Exited closes when the program ends even if a helper it left behind still
// holds a pipe open.
func StartChild(cmd *exec.Cmd, tag, what string) (*Child, error) {
	pgid, err := spawnTree(cmd, tag, what)
	if err != nil {
		return nil, err
	}
	c := &Child{cmd: cmd, pgid: pgid, tag: tag, what: what, exited: make(chan struct{})}
	go func() {
		c.waitErr = cmd.Wait()
		close(c.exited)
	}()
	return c, nil
}

// Exited closes when the program has exited.
func (c *Child) Exited() <-chan struct{} { return c.exited }

// ExitErr is how the program ended. Only meaningful once Exited has closed.
func (c *Child) ExitErr() error {
	select {
	case <-c.exited:
		return c.waitErr
	default:
		return nil
	}
}

// PID is the program's process id.
func (c *Child) PID() int {
	if c.cmd.Process == nil {
		return 0
	}
	return c.cmd.Process.Pid
}

// Stop ends the program and everything it started: a polite request, a grace
// period, then a sweep of the group. Safe to call more than once and from
// more than one goroutine; every call returns the first one's result. An
// error means members of the group survived.
func (c *Child) Stop() error {
	c.stopOnce.Do(func() {
		c.stopErr = endTree(c.pgid, c.exited, true, c.tag, c.what)
		if c.stopErr == nil {
			releaseTree(c.pgid)
		}
	})
	return c.stopErr
}
