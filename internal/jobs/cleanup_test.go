package jobs

import (
	"testing"
	"time"
)

func TestCleanupWithoutNewRequests(t *testing.T) {
	m := &Manager{maxAge: time.Hour, cleanupStop: make(chan struct{}), jobs: map[string]*Job{
		"expired": {status: StatusDone, finishedAt: time.Now().Add(-2 * time.Hour)},
		"recent":  {status: StatusDone, finishedAt: time.Now()},
		"running": {status: StatusRunning},
	}}
	done := make(chan struct{})
	go func() { m.cleanupLoop(time.Millisecond); close(done) }()
	defer m.Shutdown()
	deadline := time.Now().Add(time.Second)
	for {
		_, ok := m.get("expired")
		if !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("expired result retained without new requests")
		}
		time.Sleep(time.Millisecond)
	}
	for _, id := range []string{"recent", "running"} {
		if _, ok := m.get(id); !ok {
			t.Fatalf("recovery/live job deleted: %s", id)
		}
	}
	m.Shutdown()
	m.Shutdown()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not stop")
	}
}
