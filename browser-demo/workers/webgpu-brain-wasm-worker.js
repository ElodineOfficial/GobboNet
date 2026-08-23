// webgpu-brain-wasm-worker.js — Aitherium Bonsai brain (loader, not the engine).
//
// The engine is served from Aitherium rather than vendored into this repo. A
// module worker may import cross-origin when the response carries CORS and a
// JavaScript MIME type, and this one does:
//
//     https://gobbonet.aitherium.com/workers/webgpu-brain-wasm-worker.js
//     Access-Control-Allow-Origin: *
//     Content-Type: application/javascript
//
// WHY IT IS NOT VENDORED: the bundle is the WebGPU kernel implementation —
// compute shaders in WGSL source form. Copying it here would freeze it (this
// repo has no way to receive upstream fixes) without making the demo any more
// self-contained: the model weights already stream from weights.aitherium.com,
// so the demo depends on that origin either way. Loading the engine from the
// same place it gets its weights keeps one source of truth, and means every
// visitor here runs the current kernels rather than whatever was current on
// the day this file was copied.
//
// Offline/self-host: point this URL at your own copy. Nothing else changes.
import 'https://gobbonet.aitherium.com/workers/webgpu-brain-wasm-worker.js';
