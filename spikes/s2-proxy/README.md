# Spike S2 — Theia behind a reverse proxy

Throwaway code for Phase 00 spike S2 (`02_PHASES/PHASE_00_ENVIRONMENT_DECISIONS_SPIKES.md` step 0.5).
Results: [`docs/spikes/S2_REVERSE_PROXY.md`](../../docs/spikes/S2_REVERSE_PROXY.md).

A small Fastify proxy (`@fastify/http-proxy`, WebSockets on) in front of the S1 browser app, in two modes:

| Mode | URL | Upstream |
| --- | --- | --- |
| `path` | `http://127.0.0.1:8080/w/<id>/` | `/` of the workspace's Theia backend |
| `subdomain` | `http://<id>.ws.localhost:8080/` | same |

Requests outside a workspace route get 404 and are logged as `ESCAPE`. Spike-only routes:
`GET /__spike/escapes`, `POST /__spike/drop-sockets` (forces every WebSocket to reconnect).

## Run

Build the S1 browser app first (`spikes/s1-theia-hello`: `npm install && npm run build:browser`).

```bash
# Theia backends (from spikes/s1-theia-hello/browser-app)
npx theia start --hostname 127.0.0.1 --port 3000 <folder-a>
npx theia start --hostname 127.0.0.1 --port 3001 <folder-b>

# Proxy (from this folder, after npm install)
node proxy.mjs path                                                                  # /w/test-ws/ → :3000
WORKSPACES="ws-a=http://127.0.0.1:3000,ws-b=http://127.0.0.1:3001" node proxy.mjs path
COOKIE_PATH_REWRITE=1 WORKSPACES="ws-a=…,ws-b=…" node proxy.mjs path                 # with the fix
node proxy.mjs subdomain                                                             # test-ws.ws.localhost:8080

# Checks
node verify.mjs http://127.0.0.1:8080/w/test-ws/ out.png
node verify.mjs http://test-ws.ws.localhost:8080/ out.png
node verify-two-workspaces.mjs http://127.0.0.1:8080/w/ws-a/ http://127.0.0.1:8080/w/ws-b/
```
