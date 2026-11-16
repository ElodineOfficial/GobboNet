#!/usr/bin/env python3
"""Static contract for the macOS app builder and first-launch path."""

from pathlib import Path
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
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
        # No Dock icon: the program has no window to answer Quit, and a Dock
        # icon that cannot be quit is an invitation to Force Quit.
        self.assertIn("<key>LSUIElement</key><true/>", build)
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
                # The retrieval model is already in place, so this run fetches nothing.
                embeddings = tmp / "data/gobbonet/embeddings"
                embeddings.mkdir(parents=True)
                (embeddings / "nomic-embed-text-v1.5.Q8_0.gguf").write_text("stand-in")
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
                    "config get embed_mode",
                    "launch" + tail,
                ], detail)

    # ---- opened again, stopped, and started after a forced quit ------------
    #
    # A stand-in that really runs: the system's own `sleep`, started under the
    # program's command line (bash's `exec -a`), so `ps` shows what the launcher
    # looks for. A COPY of a system program will not do: macOS kills those when
    # they run from anywhere but the system volume. Nor will Python: the
    # framework build re-executes itself and loses the name.

    def _bundle(self, tmp):
        macos = tmp / "GobboNet.app/Contents/MacOS"
        macos.mkdir(parents=True)
        shutil.copy(ROOT / "installer-mac/GobboNet", macos / "GobboNet")
        (macos / "models.ini").write_text("")
        (macos / "gobbonet-bin").write_text(STUB)
        (macos / "gobbonet-bin").chmod(0o755)
        engine_dir = tmp / "data/gobbonet/llama-cpp"
        engine_dir.mkdir(parents=True)
        embeddings = tmp / "data/gobbonet/embeddings"
        embeddings.mkdir(parents=True)
        (embeddings / "nomic-embed-text-v1.5.Q8_0.gguf").write_text("stand-in")
        env = {"HOME": str(tmp), "XDG_DATA_HOME": str(tmp / "data"), "CALLS": str(tmp / "calls.txt"),
               "GOBBONET_MAC_CHOICE": "open"}
        return macos, engine_dir, env

    def _standin(self, command_line):
        proc = subprocess.Popen(["/bin/bash", "-c", 'exec -a "$0" /bin/sleep 600', command_line],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def reap():
            if proc.poll() is None:
                proc.kill()
            proc.wait()
        self.addCleanup(reap)
        return proc

    @unittest.skipUnless(sys.platform == "darwin", "matches processes the way macOS ps prints them")
    def test_opened_again_while_running_starts_nothing_and_can_stop_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(os.path.realpath(tmp))
            macos, engine_dir, env = self._bundle(tmp)
            server = self._standin(str(macos / "gobbonet-bin") + " launch")
            engine = self._standin(str(engine_dir / "llama-server") + " --port 11437")
            time.sleep(0.5)
            self.assertIsNone(server.poll(), "the stand-in server did not start")

            # A quiet launch (a harness, or a login item one day) leaves it alone.
            quiet = subprocess.run(["/bin/bash", str(macos / "GobboNet"), "--no-browser"],
                                   env=env, capture_output=True, text=True)
            self.assertEqual(quiet.returncode, 0, quiet.stderr)
            self.assertIsNone(server.poll(), "a second quiet launch stopped the running server")

            # "Stop GobboNet": the server and this install's engine are asked to stop.
            stop = subprocess.run(["/bin/bash", str(macos / "GobboNet")],
                                  env=dict(env, GOBBONET_MAC_CHOICE="stop"), capture_output=True, text=True)
            self.assertEqual(stop.returncode, 0, stop.stderr)
            self.assertIsNotNone(server.wait(timeout=5), "the server was not stopped")
            self.assertIsNotNone(engine.wait(timeout=5), "the engine was not stopped")
            # Asked to stop, never killed: SIGKILL is what orphans an engine.
            self.assertEqual(server.returncode, -15)
            self.assertEqual(engine.returncode, -15)

    @unittest.skipUnless(sys.platform == "darwin", "matches processes the way macOS ps prints them")
    def test_an_engine_left_by_a_forced_quit_is_stopped_before_starting(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(os.path.realpath(tmp))
            macos, engine_dir, env = self._bundle(tmp)
            # The engine file exists (so nothing is installed again) and a
            # process is running under its name.
            (engine_dir / "llama-server").write_text("#!/bin/sh\n")
            (engine_dir / "llama-server").chmod(0o755)
            orphan = self._standin(str(engine_dir / "llama-server") + " --port 11437")
            # Somebody else's llama-server, somewhere else: never ours to stop.
            other = self._standin(str(tmp / "elsewhere/llama-server") + " --port 8080")
            time.sleep(0.5)
            self.assertIsNone(orphan.poll(), "the stand-in engine did not start")

            result = subprocess.run(["/bin/bash", str(macos / "GobboNet"), "--no-browser"],
                                    env=env, capture_output=True, text=True)
            log = (tmp / "data/gobbonet/launch.log").read_text()
            self.assertEqual(result.returncode, 0, result.stderr + log)
            self.assertIsNotNone(orphan.wait(timeout=5), "the leftover engine is still running")
            self.assertIsNone(other.poll(), "a llama-server outside this install was stopped")
            self.assertIn("still running; stopping it", log)
            # The engine file is there, so nothing is installed again; the rest is a normal start.
            engine = str(engine_dir)
            self.assertEqual((tmp / "calls.txt").read_text().splitlines(), [
                "engine --dir " + engine + " status",
                "setup --status",
                "setup --catalog " + str(macos / "models.ini") + " --server-exe " + engine + "/llama-server --no-browser",
                "config get embed_mode",
                "launch --no-browser",
            ], log)

    def test_documented_unsigned_status_is_unambiguous(self):
        guide = (ROOT / "MAC-START-HERE.md").read_text()
        self.assertIn("unsigned, unnotarized", guide)
        self.assertIn("support.apple.com/en-us/102445", guide)
        self.assertNotIn("right-click", guide.lower())


if __name__ == "__main__":
    unittest.main()
