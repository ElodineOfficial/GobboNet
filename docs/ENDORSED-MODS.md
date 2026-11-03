# Publishing the endorsed mods list

*1.7.9, F6. For whoever runs goblincorps.com. The app side is
`internal/mods/endorsed.go`; this page is about the file the site serves.*

GobboNet's MODS panel has a section, **ENDORSED MODS**, that lists mods Elodine
has looked at and endorses one by one, and installs one with a click. It reads
one JSON file:

```
https://goblincorps.com/gobbonet_mod_list.json      (config.toml: mod_list_url)
```

The human-readable collection stays at
[goblincorps.com/gobbonet_extras](https://goblincorps.com/gobbonet_extras); the
panel links to it. The JSON file is what the app reads, and every file it lists
is pinned by SHA-256.

## Publishing, step by step

1. Keep one folder per mod, named by its id, each with a `mod.json`:

   ```
   my-mods/
     neon-theme/mod.json     {"name": "Neon theme", "version": "1.2.0",
                              "author": "Elodine", "description": "Pinker everything.",
                              "homepage": "https://goblincorps.com/gobbonet_extras",
                              "adult": false, "files": ["neon.css", "js/neon.js"]}
     neon-theme/neon.css
     neon-theme/js/neon.js
   ```

   This is the same layout as a mod in GobboNet's own `mods` folder, so a mod
   you have tested locally can be endorsed as it is.
   [`docs/mods-example/hello-gobbo`](mods-example/hello-gobbo) is a small one to
   try the whole path with.

2. Build the list:

   ```
   python3 catalog/gen-mod-list.py my-mods \
       --base-url https://goblincorps.com/gobbonet_mods --js-as-txt \
       --out gobbonet_mod_list.json
   ```

   Every file is hashed here, so the list pins exactly the bytes you are about
   to upload. `--js-as-txt` is for a host that will not serve `.js` files: a
   script's URL gets `.txt` on the end (`neon.js` → `neon.js.txt`), and
   GobboNet saves it as `neon.js` anyway.

3. Upload each mod folder to `<base-url>/<id>/` (with `--js-as-txt`, upload
   each script with `.txt` added to its name), then upload
   `gobbonet_mod_list.json` to the site root.

4. Before uploading the list, check it still matches the folder:

   ```
   python3 catalog/gen-mod-list.py my-mods --base-url https://goblincorps.com/gobbonet_mods \
       --js-as-txt --out gobbonet_mod_list.json --check
   ```

**Order matters on an update:** upload the new files first and the new list
second. Between the two, a user installing gets the old list's pins against the
new files, which is refused ("does not match the checksum ... nothing was
installed") rather than half-installed, and works again as soon as the list is
up. Uploading under a new folder per version (`neon-theme-1.2.0/`) avoids even
that.

## The format

```json
{
  "schema_version": 1,
  "min_client": "1.7.0",
  "generated": "2026-10-27T18:00:00Z",
  "mods": [{
    "id": "neon-theme",
    "type": "mod",
    "name": "Neon theme",
    "version": "1.2.0",
    "author": "Elodine",
    "description": "Pinker everything.",
    "homepage": "https://goblincorps.com/gobbonet_extras",
    "adult": false,
    "min_client": "1.7.9",
    "files": [
      {"path": "neon.css", "url": "https://goblincorps.com/gobbonet_mods/neon-theme/neon.css",
       "sha256": "<64 hex>", "size": 1234}
    ]
  }]
}
```

| Field | |
|---|---|
| `schema_version` | `1`. A list with any other number is refused whole, not misread. |
| `min_client` | The oldest GobboNet that may read the list. Keep it `1.7.0`; use a mod's own `min_client` for a mod that needs something newer. |
| `id` | Lower-case letters, digits, `.`, `-`, `_`; it is the folder name on the user's PC. |
| `type` | `"mod"`, or left out. Other types (characters, prompts) are skipped with a note, so they can be added to the same list later without breaking 1.7.9. |
| `version` | Any string. A different version from the one installed is offered as an UPDATE. |
| `adult` | `true` keeps the mod covered until the viewer says they are 18 or older on that device. |
| `min_client` (per mod) | Listed, but not installable, on an older GobboNet, with the reason shown. |
| `files[].path` | Where the file goes inside the mod's folder, and its type (`.css` is a stylesheet, `.js` a script; images and fonts may be listed for the CSS to use). |
| `files[].url` | `https://` only. |
| `files[].sha256` | Required. A file without one leaves the whole mod off the list, with a note. |

Limits: 20 files per mod, 5 MB per file, 20 MB per mod, 1 MB for the list.

## What the app does with it

- **Nothing until asked.** The list is fetched by GobboNet on the PC (never by
  the browser) when someone clicks BROWSE, as a plain GET with nothing
  identifying, and kept for ten minutes. A mod's files are fetched only when
  someone clicks INSTALL.
- **The last good copy** is saved in the data folder, and shown, marked as a
  saved copy with its date, when the site cannot be reached.
- **Install** downloads every file, checks each against its pin, and only then
  puts the mod in place. One mismatch and nothing is installed.
- **The switch belongs to the user.** A new install is switched on once; an
  update replaces the files and keeps the switch as it was.
- **Never over someone's own work.** A folder of the same name that did not come
  from the list is left alone, and the list says so.
- **This PC only.** Installing, like anything else that adds or switches on a
  mod, works only in a browser on the PC GobboNet runs on. Other devices can
  look.
- **A broken mod switches itself off.** A mod file that will not load, or a
  script that throws while it first runs, switches its mod off and says so.
