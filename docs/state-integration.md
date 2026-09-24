# Reading authoritative server state

Available in the bundled UI after its scripts have loaded:

```js
// Wait for the initial state check and UI setup. This always resolves; inspect ok.
const ready = await window.GobboNet.ready;
if (!ready.ok) console.error(ready.error);

// A fresh server read, independent of local storage and previous boot attempts.
const snapshot = await window.GobboNet.fetchServerState();
if (snapshot !== null) {
  const characters = snapshot.characterCards || [];
  const personas = snapshot.personaCards || [];
  // Zero threads is valid: these rosters may still contain user-created cards.
}
```

`ready` resolves to `{ok, error, sync}`. It covers initial state restoration and
UI setup, not completion of background replies or all subsequent synchronization.
`sync` is the current target label (`shared`, a profile name, or `off`). A local-only
startup can be ready without contacting a server. A failed startup check reports
`ok: false`; it does not claim that default local state came from the server.

`fetchServerState({profile, signal})` returns a fresh snapshot, `null` on 404, and
rejects on network/authentication/server/validation errors. Omit `profile` to use
the UI's current target. Supply a valid named profile to read that profile; names
are normalized to lowercase. `signal` is an optional AbortSignal. Sync switched
off or a file:// page rejects instead of silently contacting another target.
The helper can be called again after a failure and does not require awaiting
`ready`. It issues only GET: no writes, deletion, local cache updates, code
execution or changes to the UI's active character/persona. Returned custom-code
fields are data; do not execute them. Normal UI restores separately disable them.

The complete GobboNet UI still synchronizes in both directions. Loading the UI
and using this helper does **not** turn the entire UI into a read-only client.
For an independent app that only reads and creates/appends conversations, use
the HTTP routes directly, with the normal server authentication:

| Operation | Route | Contract |
| --- | --- | --- |
| Read complete snapshot | `GET /state` | Zero threads is valid; 404 means no saved document |
| Read settings/cards/personas without chat history | `GET /state/meta` | Returns metadata and its ETag |
| Read one thread | `GET /state/threads/{id}` | Retain its ETag for conditional append |
| Create a thread | `PUT /state/threads/{id}` | `If-None-Match: *`; JSON thread with matching id and messages array |
| Append messages | `POST /state/threads/{id}/append` | `If-Match: <thread ETag>`; body is a JSON array of messages |

Send `Content-Type: application/json` on writes. For a named profile, use the
same `?profile=name` on **every** request. Encode thread IDs as URL path segments.
On 412, re-read the thread and decide whether the intended messages are already
present before retrying; blindly retrying can duplicate messages. These create
and append routes preserve other threads and metadata. Avoid whole-document PUT,
metadata PUT and DELETE for this limited client. Active character/persona choices
can stay in the app's memory; stamp the appropriate card/persona IDs on the new
thread/messages according to GobboNet's existing state format.

These are client behavior constraints, not a restricted server credential: the
helper does not introduce a read/create/append-only authorization role.
