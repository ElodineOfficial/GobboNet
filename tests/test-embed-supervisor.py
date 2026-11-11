#!/usr/bin/env python3
"""1.8.0 (#15): GobboNet supervises the embedding server; the launchers do not.

Up to 1.7.9 launch.bat (Windows) and gobbonet-launch (Linux) started the
embedding server, and nothing watched it: a crash turned semantic search off
with no notice, and a Start-menu launch, which runs gobbonet.exe without
launch.bat, started none at all. Now gobbonet starts it (internal/supervisor
/embed.go), checks the model against its pin before every start, restarts it
with the chat model's backoff, and stands it down with the chat model.

What this pins, statically (the Go side has its own tests):

  * neither launcher starts an embedding server any more, in either copy of
    gobbonet-launch, and the two copies are identical;
  * launch.bat still DOWNLOADS the model on a Windows first run, into
    models\\ where gobbonet looks, checked against EMBED_PIN_SHA256, and
    EMBED_ENABLE=0 now writes embed_mode = "off";
  * the pin, the file name and the download address are the same everywhere
    they are written: launch.bat, internal/config/embed.go, and both copies
    of gobbonet-setup.py (the Linux setup wizard's "Download Nomic");
  * config.toml documents the four new keys, and the server reports the
    state on /health-fileserver.

Run:  python3 tests/test-embed-supervisor.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if not ok:
        if detail:
            print(f"        {detail}")
        failures.append(name)


def read(rel):
    return open(os.path.join(ROOT, rel), "rb").read().decode("utf-8", errors="replace")


def code_of(text, comment=("::", "rem ")):
    return "\n".join(l for l in text.replace("\r\n", "\n").split("\n")
                     if not l.strip().lower().startswith(comment))


def main():
    bat = read("launch.bat")
    bat_code = code_of(bat)
    go = read("internal/config/embed.go")
    setup = read("installer-linux/gobbonet-setup.py")
    launch = read("installer-linux/gobbonet-launch")

    print("the launchers start no embedding server")
    check("launch.bat has no --embeddings command line", "--embeddings" not in bat_code)
    check("launch.bat starts nothing in a minimised window", "start /min" not in bat_code)
    check("launch.bat's embedding launcher script is gone",
          "EMBED_LAUNCH_SCRIPT" not in bat and ":embed_spawn" not in bat and ":embed_wait" not in bat)
    launch_code = code_of(launch, ("#",))
    check("gobbonet-launch has no --embeddings command line", "--embeddings" not in launch_code)
    check("and no embedding process to clean up", "EMBED_PID" not in launch)
    check("the ZIP copy of gobbonet-launch is identical",
          read("linux-amd64/gobbonet-launch") == launch)
    check("the ZIP copy of gobbonet-setup.py is identical",
          read("linux-amd64/gobbonet-setup.py") == setup)

    print("\nlaunch.bat still downloads it on a Windows first run")
    check("into models\\, where gobbonet looks", 'set "EMBED_PATH=!MODEL_DIR!\\!EMBED_MODEL_GGUF!"' in bat_code)
    check("and checks it against EMBED_PIN_SHA256",
          'if /i "!EMBED_ACTUAL!"=="!EMBED_PIN_SHA256!"' in bat_code)
    check("a model already there is left alone",
          re.search(r'if exist "!EMBED_PATH!" \(\n\s*echo .*gobbonet\.exe starts the embedding server', bat_code) is not None)
    check('EMBED_ENABLE=0 writes embed_mode = "off"',
          re.search(r'if /i "!EMBED_ENABLE!"=="0" \(.*?config set embed_mode off.*?goto :start_proxy', bat_code, re.S) is not None)

    print("\none pin, one file, one address")
    pins = {
        "launch.bat": re.findall(r'set "EMBED_PIN_SHA256=([0-9a-f]{64})"', bat),
        "internal/config/embed.go": re.findall(r'EmbedModelSHA256 = "([0-9a-f]{64})"', go),
        "gobbonet-setup.py": re.findall(r"expected = '([0-9a-f]{64})'", setup),
    }
    flat = [p for v in pins.values() for p in v]
    check("each place has exactly one pin", all(len(v) == 1 for v in pins.values()), pins)
    check("and they are all the same", len(set(flat)) == 1, pins)
    names = {
        "launch.bat": re.findall(r'set "EMBED_MODEL_GGUF=([^"]+)"', bat),
        "embed.go": re.findall(r'EmbedModelFile += "([^"]+)"', go),
        "gobbonet-setup.py": re.findall(r"final = dest / '([^']+)'", setup),
    }
    check("the file name is the same everywhere", len({n for v in names.values() for n in v}) == 1, names)
    bat_url = re.findall(r'set "EMBED_MODEL_URL=([^"?]+)', bat)
    go_url = re.findall(r'EmbedModelURL += "([^"]+)" \+ EmbedModelFile', go)
    setup_url = re.findall(r"url = '([^']+)' \+ final\.name", setup)
    check("and so is where it comes from",
          bat_url and go_url and setup_url and bat_url[0] == go_url[0] + names["embed.go"][0] == setup_url[0] + names["embed.go"][0],
          (bat_url, go_url, setup_url))

    print("\nthe settings and the report")
    toml = read("internal/config/file.go")
    for key, value in (("embed_mode", '"managed"'), ("embed_model", '""'), ("embed_gpu_layers", "0"), ("embed_ctx", "2048")):
        check(f"config.toml documents {key} = {value}", re.search(r"^%s = %s$" % (key, re.escape(value)), toml, re.M) is not None)
    srv = read("internal/server/server.go")
    check('/health-fileserver reports "embed"', 'body["embed"], body["embed_detail"] = s.embedState()' in srv)
    check("an /embed request wakes a stood-down embedding server first",
          "s.embed.WakeAndWait(embedWakeWait)" in srv[srv.find('case path == "/embed"'):][:600])

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
