package supervisor

import (
	"fmt"
	"log"
	"net"
	"os/exec"
	"time"
)

// The process half every engine GobboNet runs shares (1.8.0, #15).
//
// Until 1.8.0 only llama-server had any of this: its own process group, a
// Windows job that ends it when gobbonet dies, a sweep of the whole group on
// stop, and a restart loop with backoff. The embedding server was started by a
// script and watched by nothing, so a crash turned semantic search off with no
// notice. Now both run through the same functions below -- one way to launch,
// one way to stop, one restart loop -- which is the point the package comment
// makes about launch.bat's old monitor loop: two mechanisms for one job drift
// apart. MCP servers (#16) are next to use them.
//
// The state machines stay with their owners: the chat model's swaps, rollback
// and idle stand-down live in Supervisor, the embedding server's adoption of a
// server it did not start lives in Embedder.

// spawnTree starts cmd as the head of its own process group and ties the group
// to this process's lifetime, then returns the group's id for endTree.
//
// The tie is a backstop for abnormal exits (a kill that runs no Go code here),
// so failing to make it is logged rather than fatal: every explicit cleanup
// path still works without it.
func spawnTree(cmd *exec.Cmd, tag, what string) (int, error) {
	configureProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("could not start %s: %w", what, err)
	}
	if err := superviseTree(cmd); err != nil {
		log.Printf("%s could not tie %s to this process's lifetime: %v", tag, what, err)
		log.Printf("%s it will still be stopped normally; a forced kill of gobbonet may leave it running", tag)
	}
	return processGroupID(cmd), nil
}

// endTree stops a launched group: the polite request first (unless the leader
// has already gone), a grace period for the leader to exit, then a sweep of
// every member. It returns an error only when members survive, which callers
// treat as "still owned": nothing may be started in its place.
//
// The leader having exited is NOT a reason to stop early. Its helpers get
// reparented and keep running, still holding VRAM and the port; the group
// still has to be swept.
func endTree(pgid int, exited <-chan struct{}, haveLeader bool, tag, what string) error {
	if haveLeader {
		leaderGone := false
		select {
		case <-exited:
			leaderGone = true
		default:
		}
		if !leaderGone {
			if err := terminateGroup(pgid, false); err != nil {
				log.Printf("%s SIGTERM to process group failed: %v", tag, err)
			}
			select {
			case <-exited:
			case <-time.After(gracePeriod):
				log.Printf("%s %s did not exit in %s; forcing", tag, what, gracePeriod)
			}
		}
	}
	return reapTree(pgid, tag)
}

// reapTree ensures nothing from a launched process group is left running.
//
// Membership, not the leader's exit status, is the completion condition -- a
// helper that ignored SIGTERM, or one orphaned when its parent crashed, is
// invisible to cmd.Wait() and to any walk of our own descendants, but it still
// holds the memory the next start needs.
func reapTree(pgid int, tag string) error {
	if pgid <= 0 || !groupAlive(pgid) {
		return nil
	}
	if err := terminateGroup(pgid, false); err != nil {
		log.Printf("%s SIGTERM to process group failed: %v", tag, err)
	}
	if waitGroupGone(pgid, gracePeriod) {
		return nil
	}
	log.Printf("%s process group %d outlived SIGTERM; forcing", tag, pgid)
	if err := terminateGroup(pgid, true); err != nil {
		log.Printf("%s SIGKILL to process group failed: %v", tag, err)
	}
	if !waitGroupGone(pgid, gracePeriod) {
		return fmt.Errorf("process group %d survived termination; refusing to start another", pgid)
	}
	return nil
}

// waitGroupGone polls until the group is empty or the deadline passes.
func waitGroupGone(pgid int, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if !groupAlive(pgid) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return !groupAlive(pgid)
}

// waitAddrFree blocks until nothing accepts on address, or portFreeTimeout.
//
// Not optional after a stop: Kill returns before the kernel has released the
// listening socket, and a replacement started too early fails to bind and
// exits within milliseconds -- which looks exactly like a slow load.
func waitAddrFree(address string) error {
	deadline := time.Now().Add(portFreeTimeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", address, 200*time.Millisecond)
		if err != nil {
			return nil
		}
		conn.Close()
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("port %s is still occupied; refusing to start another engine", address)
}

// addrInUse reports whether something accepts connections on address.
func addrInUse(address string) bool {
	conn, err := net.DialTimeout("tcp", address, 200*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// maxRecoveryBackoff caps the wait between restart attempts.
const maxRecoveryBackoff = 2 * time.Minute

// recoveryLoop is the restart loop both engines use after an unplanned exit.
//
// It waits, makes an attempt, and doubles the wait after each failure, from
// `first` (one second normally) to two minutes, until an attempt says it is
// done or shutdown closes. Exponential because the common cause of a crash on
// start is a configuration problem that will not fix itself, and hammering
// the machine with attempts makes the logs unreadable without helping.
// Unbounded because a GPU driver reset, or a card another program is holding,
// can take longer than any fixed number of tries to clear (1.7.5's rule).
//
// attempt returns true to end the loop: it succeeded, or the state it was
// started for has moved on (a swap, a stand-down, a newer generation).
func recoveryLoop(first time.Duration, shutdown <-chan struct{}, attempt func(n int) bool) {
	backoff := first
	if backoff <= 0 {
		backoff = time.Second
	}
	for n := 1; ; n++ {
		select {
		case <-shutdown:
			return
		case <-time.After(backoff):
		}
		if attempt(n) {
			return
		}
		if backoff *= 2; backoff > maxRecoveryBackoff {
			backoff = maxRecoveryBackoff
		}
	}
}
