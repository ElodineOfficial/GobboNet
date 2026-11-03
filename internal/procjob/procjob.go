// Package procjob ties a child process tree to this process's lifetime.
//
// It exists for `gobbonet launch` on Windows (1.7.9, PR #15). The launcher runs
// launch.bat through cmd.exe, and launch.bat starts the embedding server with
// `start /min` before handing over to gobbonet.exe in the foreground. Closing
// the console window, End task, or a crash ends the launcher with no chance to
// clean up, and every process launch.bat had started kept running, holding
// ports and memory.
//
// On Windows the tree goes into a job object with KILL_ON_JOB_CLOSE: when the
// last handle to the job closes, which the kernel does when this process dies
// for any reason, every process still in the job is ended. Membership is
// inherited, so whatever cmd.exe starts joins too.
//
// The job also allows BREAKAWAY, and Detach puts a child outside it. That is
// for the browser: `--open` starts it from inside the tree, and a browser that
// was not already running would otherwise be closed along with GobboNet.
//
// Everywhere else these are documented no-ops; see procjob_other.go.
package procjob
