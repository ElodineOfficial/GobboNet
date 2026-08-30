package setup

import _ "embed"

// The wizard is compiled in rather than installed beside the binary. It runs
// before any config exists to tell it where a web root would be, and a first
// run that fails because one file is missing is the worst possible time to
// depend on the filesystem. web/ stays external; this does not.
//
//go:embed wizard.html
var wizardHTML []byte
