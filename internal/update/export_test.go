package update

import "time"

// For the external tests in update_test.go.
var (
	LocateFor = locate
	Swap      = swap
)

func SetStallTimeout(d time.Duration) func() {
	old := stallTimeout
	stallTimeout = d
	return func() { stallTimeout = old }
}
