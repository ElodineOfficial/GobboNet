package setup

import (
	"bufio"
	"strconv"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/engine"
)

// System RAM for the wizard's fit check (issue #65).
//
// A Mixture-of-Experts model also fits a smaller card when system RAM can
// hold the experts that do not fit on it, so the wizard needs this figure
// beside the VRAM one. Linux only, from /proc/meminfo: the wizard this serves
// is the Linux setup path. Elsewhere it is 0, which confirms nothing -- the
// wizard then falls back to the VRAM rule alone, and warns as it always did.

// standardRAMGB are the capacities machines ship with. MemTotal is less than
// the installed RAM -- the kernel, firmware and an integrated GPU's stolen
// memory all come out of it -- so it is rounded up to the size someone would
// say they have, within 8%. A 32 GB laptop reporting 30 GiB is a 32 GB laptop.
var standardRAMGB = []int{2, 4, 6, 8, 12, 16, 20, 24, 32, 36, 40, 48, 64, 96, 128, 192, 256, 384, 512}

// ramGBFromMeminfo reads MemTotal (in kB) out of /proc/meminfo's text and
// returns it as a nominal size in GB, or 0 when it is not there.
func ramGBFromMeminfo(text string) int {
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 || f[0] != "MemTotal:" {
			continue
		}
		kb, err := strconv.ParseFloat(f[1], 64)
		if err != nil || kb <= 0 {
			return 0
		}
		return nominalRAMGB(kb / (1024 * 1024))
	}
	return 0
}

func nominalRAMGB(gib float64) int {
	for _, std := range standardRAMGB {
		if float64(std) < gib {
			continue
		}
		if (float64(std)-gib)/float64(std) <= 0.08 {
			return std
		}
		break
	}
	return int(gib)
}

// systemRAMGB is this machine's RAM in nominal GB, or 0 when unknown.
func systemRAMGB() int {
	mib := engine.SystemRAMMiB()
	if mib <= 0 {
		return 0
	}
	return nominalRAMGB(float64(mib) / 1024)
}
