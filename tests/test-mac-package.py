#!/usr/bin/env python3
"""Static contract for the macOS app builder and first-launch path."""

from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

# A stand-in for the Go binary: it writes down how it was called and answers
# the way a first launch would be answered (no engine yet, setup not done).
STUB = r"""#!/bin/sh
printf '%s\n' "$*" >> "$CALLS"
case "$1" in
  engine)
    # engine --dir DIR status|install
    if [ "$4" = "install" ]; then
      mkdir -p "$3" && printf '#!/bin/sh\n' > "$3/llama-server" && chmod 755 "$3/llama-server"
      exit 0
    fi
    [ -x "$3/llama-server" ]
    exit $?
    ;;
  setup)
    [ "$2" = "--status" ] && exit 1
    exit 0
    ;;
esac
exit 0
"""


class MacPackage(unittest.TestCase):
    def test_scripts_parse_and_package_the_pinned_inputs(self):
        builder = ROOT / "installer-mac/build-app.sh"
        launcher = ROOT / "installer-mac/GobboNet"
        for script in (builder, launcher):
            result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

        build = builder.read_text()
        for required in (
            "scripts/stage-web.sh", "engine.sha256", "catalog/models.ini",
            "GOOS=darwin", "--keepParent", "unzip -tq", "plutil -lint",
        ):
            self.assertIn(required, build)

        launch = launcher.read_text()
        self.assertIn('BIN="$HERE/gobbonet-bin"', launch)
        self.assertRegex(launch, r'engine --dir "\$ENGINE_DIR" install')
        self.assertIn('setup --catalog "$CATALOG" --server-exe "$ENGINE"', launch)
        self.assertIn('exec "$BIN" launch', launch)
        # Default Mac disks are case-insensitive: the Finder entry point and
        # the Go payload must not differ only by case, or one overwrites the
        # other in the bundle. Read both names out of the builder.
        entry = re.search(r"<key>CFBundleExecutable</key><string>([^<]+)</string>", build).group(1)
        payload = re.search(r'-o "\$MACOS/([^"]+)"', build).group(1)
        self.assertNotEqual(entry.casefold(), payload.casefold())
        self.assertIn('BIN="$HERE/' + payload + '"', launch)

    @unittest.skipUnless(os.path.exists("/bin/bash"), "needs /bin/bash")
    def test_launcher_runs_a_first_launch_on_the_systems_own_bash(self):
        """Run the real launcher against a stand-in binary, with and without
        its one argument.

        macOS still ships bash 3.2, where expanding an EMPTY array under
        `set -u` is an error. The launcher first kept --no-browser in an
        array, so an ordinary double-click (no arguments at all) installed the
        engine and then died. Nothing static catches that; running it does.
        """
        launcher = ROOT / "installer-mac/GobboNet"
        for args in ([], ["--no-browser"]):
            with self.subTest(args=args), tempfile.TemporaryDirectory() as tmp:
                tmp = Path(os.path.realpath(tmp))
                macos = tmp / "GobboNet.app/Contents/MacOS"
                macos.mkdir(parents=True)
                shutil.copy(launcher, macos / "GobboNet")
                (macos / "models.ini").write_text("")
                stub = macos / "gobbonet-bin"
                stub.write_text(STUB)
                stub.chmod(0o755)
                calls = tmp / "calls.txt"
                env = {"HOME": str(tmp), "XDG_DATA_HOME": str(tmp / "data"), "CALLS": str(calls)}
                result = subprocess.run(["/bin/bash", str(macos / "GobboNet"), *args],
                                        env=env, capture_output=True, text=True)
                log = tmp / "data/gobbonet/launch.log"
                detail = result.stderr + (log.read_text() if log.exists() else "")
                self.assertEqual(result.returncode, 0, detail)
                engine = str(tmp / "data/gobbonet/llama-cpp")
                tail = (" " + args[0]) if args else ""
                self.assertEqual(calls.read_text().splitlines(), [
                    "engine --dir " + engine + " status",
                    "engine --dir " + engine + " install",
                    "setup --status",
                    "setup --catalog " + str(macos / "models.ini") + " --server-exe " + engine + "/llama-server" + tail,
                    "launch" + tail,
                ], detail)

    def test_documented_unsigned_status_is_unambiguous(self):
        guide = (ROOT / "MAC-START-HERE.md").read_text()
        self.assertIn("unsigned, unnotarized", guide)
        self.assertIn("support.apple.com/en-us/102445", guide)
        self.assertNotIn("right-click", guide.lower())


if __name__ == "__main__":
    unittest.main()
