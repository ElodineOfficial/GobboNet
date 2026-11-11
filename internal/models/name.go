package models

import (
	"errors"
	"fmt"
	"strings"
)

// ErrBadFileName is the error CheckFileName wraps.
var ErrBadFileName = errors.New("not a model file name")

// maxFileName is the longest name any filesystem GobboNet runs on will hold.
const maxFileName = 255

// CheckFileName reports whether name can only mean a file directly inside the
// models folder: a plain file name ending in .gguf (1.8.0).
//
// Every model GobboNet lists already is one -- ScanDir reads the folder one
// level deep, and USE IT links found models in under their own base name -- so
// nothing that could be picked is refused. What is refused is a name that
// lands somewhere else once joined onto the folder, on any OS: "../x.gguf",
// "sub/x.gguf", "sub\x.gguf", "C:x.gguf", "x.gguf:stream" (an NTFS alternate
// stream); and a file that is not a model at all.
//
// Model names arrive from outside this PC: /swap-model takes one from any
// signed-in device, the model list is fetched from the network, and imported
// cards and synced chats will carry one (#52). So the check is made where a
// name is turned into a path, not where it was typed.
func CheckFileName(name string) error {
	bad := func(why string) error { return fmt.Errorf("%w: %s", ErrBadFileName, why) }
	switch {
	case name == "":
		return bad("empty")
	case len(name) > maxFileName:
		return bad("too long")
	case name == "." || name == "..":
		return bad("not a file")
	}
	for _, r := range name {
		switch {
		case r == '/' || r == '\\':
			return bad("contains a folder separator")
		case r == ':':
			return bad("contains a colon")
		case r < 0x20 || r == 0x7f:
			return bad("contains a control character")
		}
	}
	if len(name) <= len(".gguf") || !strings.EqualFold(name[len(name)-len(".gguf"):], ".gguf") {
		return bad("does not end in .gguf")
	}
	return nil
}
