#!/usr/bin/env python3
"""Static contract for the macOS app builder and first-launch path."""

from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


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
        # Default APFS volumes are case-insensitive. The Finder entry point and
        # Go payload must not differ only by case or one overwrites the other.
        self.assertNotEqual("GobboNet".casefold(), "gobbonet-bin".casefold())

    def test_package_sources_are_public_safe(self):
        files = [
            ROOT / "installer-mac/build-app.sh",
            ROOT / "installer-mac/GobboNet",
            ROOT / "docs/MAC-START-HERE.md",
        ]
        private = re.compile(r"/Users/[A-Za-z0-9._-]+|192\.168\.|10\.\d+\.\d+\.\d+")
        for path in files:
            self.assertIsNone(private.search(path.read_text()), str(path))

    def test_documented_unsigned_status_is_unambiguous(self):
        guide = (ROOT / "docs/MAC-START-HERE.md").read_text()
        self.assertIn("unsigned, unnotarized", guide)
        self.assertIn("support.apple.com/en-us/102445", guide)
        self.assertNotIn("right-click", guide.lower())


if __name__ == "__main__":
    unittest.main()
