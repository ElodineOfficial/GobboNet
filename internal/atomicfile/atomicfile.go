// Package atomicfile replaces a file's contents in one step, so a reader either
// sees the old file or the new one and never a half-written one.
//
// It exists because the same nine lines had been written three times — in
// config, state and catalog — and all three shared a flaw. Each derived the
// temporary file's name from the destination:
//
//	tmp := path + ".tmp"
//	os.WriteFile(tmp, body, 0o600)
//	os.Rename(tmp, path)
//
// One writer at a time, that is correct. Two writers at a time both open the
// same temporary path, the first rename moves it away, and the second fails
// with ENOENT — reported to a user as an unexplained error on a button that
// worked a moment ago. That is issue #16's setup failure, and the reason it
// looked random is that it needed the two writes to overlap.
//
// os.CreateTemp gives every writer its own file, so concurrent writers stop
// colliding. The last rename wins, which is the expected outcome for two
// writers racing over one file, and every writer either succeeds completely or
// leaves the previous contents untouched.
//
// One shared implementation rather than a fourth copy: the bug was cheap to
// write three times and expensive to find once.
package atomicfile

import (
	"os"
	"path/filepath"
)

// Write replaces the file at path with body, creating it if absent.
//
// The temporary file is created in the destination's own directory, which is
// not incidental: os.Rename is only atomic within a filesystem, and a temp file
// elsewhere (/tmp, say) can land on a different one and fail at the rename with
// an "invalid cross-device link" that only shows up on some machines.
//
// A failure at any point removes the temporary file. Leaving it behind would
// litter the user's config directory with debris named after their own files.
//
// Not synced to disk before the rename, matching the behaviour this replaced.
// That means a power loss immediately after a write can still lose the new
// contents — but it cannot corrupt the old ones, which is the property these
// callers actually depend on.
func Write(path string, body []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)

	// The leading dot keeps a half-finished write from showing up in a
	// directory listing next to the real file. The pattern is only a hint;
	// CreateTemp appends the randomness that makes it unique.
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()

	discard := func(cause error) error {
		f.Close()
		os.Remove(tmp)
		return cause
	}

	if _, err := f.Write(body); err != nil {
		return discard(err)
	}
	// CreateTemp always makes 0600. Set the mode the caller asked for while we
	// still hold the descriptor, so there is no window where the file exists
	// with the wrong permissions.
	if err := f.Chmod(perm); err != nil {
		return discard(err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
