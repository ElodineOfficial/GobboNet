// Package storelock excludes encryption maintenance while the server is running.
// The OS releases the lock on exit, including crashes. The file stays in place:
// removing it would let two processes lock different files with the same name.
package storelock

import (
	"fmt"
	"os"
	"path/filepath"
)

func Acquire(dir string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, ".state.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := lock(f); err != nil {
		f.Close()
		return nil, fmt.Errorf("cannot exclusively open history in %s: stop GobboNet and any other encryption/password command first: %w", dir, err)
	}
	return f, nil
}
