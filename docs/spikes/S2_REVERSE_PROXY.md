# Spike S2 — Theia behind a reverse proxy (`/w/{id}/` vs subdomain)

**Date:** 2026-10-17 · **Phase:** 00, step 0.5 · **Code:** [`spikes/s2-proxy/`](../../spikes/s2-proxy/) · **Decides:**
ADR-005 · **Environment:** Linux x64 container, Node 24.22.0, Theia 1.76.0 (S1 browser app, production build),
Fastify 5.12.5 + `@fastify/http-proxy` 11.6.3, headless Chromium

## Question

Can a Theia browser backend be served under a per-workspace path `/w/{id}/` behind our gateway, or do we need a
subdomain per workspace? What breaks, and what must the gateway do?

## Result

**Both work.** Through the proxy, the IDE loads, the command palette runs `qe.hello`, and an integrated
terminal spawns a shell in the workspace backend. **No change to Theia was needed** for either mode. Path
routing needs **one gateway fix** for users who have two workspaces open, now proven.

| Check | Path `/w/test-ws/` | Subdomain `test-ws.ws.localhost` |
| --- | --- | --- |
| Assets load (relative `./bundle.js`, `./bundle.css`) | ✔ | ✔ |
| Socket.IO WebSocket | ✔ `ws://…/w/test-ws/socket.io/` | ✔ `ws://test-ws.ws.localhost:8080/socket.io/` |
| Command + terminal round-trip | ✔ | ✔ |
| Page requests outside the workspace route | none | none |
| Requests the proxy had to reject | `GET /favicon.ico` (browser default) | none (only my deliberate wrong-host test) |
| `/w/test-ws` without trailing slash | must redirect to `/w/test-ws/` (308) | n/a |

```text
$ node verify.mjs http://127.0.0.1:8080/w/test-ws/ docs/spikes/s2/path-based.png
  "message": "Hello from QE Workspace (browser)", "terminalOk": true, "httpRequests": 10,
  "webSockets": ["ws://127.0.0.1:8080/w/test-ws/socket.io/?EIO=4&transport=websocket&sid=…"],
  "requestsOutsideRoute": [], "httpErrorsOrFailures": [], "proxyEscapes": {"GET 127.0.0.1:8080/favicon.ico": 1}
$ node verify.mjs http://test-ws.ws.localhost:8080/ docs/spikes/s2/subdomain.png
  "message": "Hello from QE Workspace (browser)", "terminalOk": true, "httpRequests": 8,
  "webSockets": ["ws://test-ws.ws.localhost:8080/socket.io/?EIO=4&transport=websocket&sid=…"],
  "requestsOutsideRoute": [], "httpErrorsOrFailures": []
```

Screenshots: [path-based](s2/path-based.png) · [subdomain](s2/subdomain.png).

### Why a sub-path works

Theia's frontend derives every server URL from `location.pathname`: `Endpoint.getWebSocketUrl()` /
`getRestUrl()` use `${host}${pathname}${path}`, and Socket.IO's path is `location.pathname + 'socket.io'`
(`@theia/core/lib/browser/endpoint.js`, `messaging/ws-connection-source.js`). The backend needs no base-path
setting; the proxy strips `/w/{id}`.

## Finding: two workspaces on one origin break each other (path routing)

Theia 1.76 browser backends protect every WebSocket with a **`theia-connection-token`** cookie: a random
value per backend process, set `HttpOnly; SameSite=Strict; Path=/`, and checked on every upgrade
(`@theia/core/lib/node/hosting/browser-connection-token.js`). With path routing, all workspaces share one
origin. The browser keeps **one** cookie of that name, so opening workspace B overwrites A's token. A keeps
working until its socket reconnects (network blip, laptop sleep, gateway restart), then gets `403`.

Reproduced with two backends behind the proxy, one browser profile, open A → open B → drop all sockets:

| Proxy | Cookies after A and B | A after reconnect | B after reconnect | Rejections | Runs |
| --- | --- | --- | --- | --- | --- |
| plain | one `theia-connection-token path=/` | **✘ broken** | ✔ | `403 /w/ws-a/socket.io/` | 2/2 |
| `Set-Cookie` path rewritten to `/w/{id}/` | one per workspace (`path=/w/ws-a/`, `path=/w/ws-b/`) | ✔ | ✔ | none | 2/2 |

**Gateway requirement:** rewrite `Path=/` in the runtime's `Set-Cookie` headers to `Path=/w/{id}/` (NGINX
`proxy_cookie_path / /w/$id/;`, or the router's response-header hook, as in `proxy.mjs`). The alternative is to
rebind Theia's `BrowserConnectionToken` cookie options in our backend module, which depends on internal APIs.

## Webviews (source analysis; not run, since the S1 app has no plugin host)

`@theia/plugin-ext` serves each webview from its own origin, **`{{uuid}}.webview.{{hostname}}`**
(`WebviewExternalEndpoint.defaultPattern`), overridable with `THEIA_WEBVIEW_EXTERNAL_ENDPOINT` (browser only;
Electron always uses the default). The webview URL keeps the page's path:
`Endpoint({ host: <pattern>, path: '/webview' })` → `https://{uuid}.webview.<host>/w/{id}/webview/…`.

- **Path routing:** one wildcard certificate and DNS entry `*.webview.<host>`; the gateway routes webview hosts
  by the same `/w/{id}/` prefix. Origin isolation between webviews is kept.
- **Subdomain routing:** the default becomes `{uuid}.webview.{id}.ws.<domain>`, two labels deep, so a
  `*.ws.<domain>` certificate does not cover it. Each runtime would need its own pattern, e.g.
  `{{uuid}}-{id}.webview.<domain>`, set through its environment.
- Never set the pattern to `{{hostname}}`; that serves webviews same-origin and removes their isolation.

To verify empirically in Phase 02, when `@theia/plugin-ext` and a webview extension (e.g. Markdown preview)
are added.

## Comparison for ADR-005

| Criterion | Path `/w/{id}/` | Subdomain `{id}.ws.<domain>` |
| --- | --- | --- |
| Theia support | ✔ out of the box | ✔ out of the box |
| Matches existing contracts | ✔ `ideUrl: "/w/{id}/"` (05_API_CONTRACTS §2.2) | ✘ contract change |
| DNS / TLS | IDE host + `*.webview.<host>` | `*.ws.<domain>` + per-runtime webview pattern + `*.webview.<domain>` |
| Gateway session cookie | host cookie, sent to all `/w/*` | needs `Domain=.ws.<domain>` or a per-subdomain login hand-off |
| Theia connection token | **needs `Set-Cookie` path rewrite** (proven) | host-only per subdomain, no collision |
| Isolation between a user's workspaces | shared origin: code in A's frontend can call `/w/B/` as the same user, and storage is shared | separate origins (same-origin policy) |
| Isolation between users | gateway authorization on every request (both modes) | same |
| Webview isolation | ✔ per-webview origin | ✔ per-webview origin |

**Recommendation: path-based `/w/{id}/` for v1**, with these gateway controls (Phase 05):

1. authorize every HTTP request **and** WebSocket upgrade against the workspace (404 if not visible);
2. rewrite runtime `Set-Cookie` paths to `/w/{id}/`;
3. 308-redirect `/w/{id}` → `/w/{id}/`; serve `/favicon.ico` at the root; 404 everything else;
4. route `*.webview.<host>/w/{id}/…` to the same runtime, with a wildcard certificate;
5. only allowlisted extensions (ADR-010), which limits code that can run in the shared frontend origin.

Revisit (switch to subdomains) if the Phase 14 threat-model review requires origin isolation between one
user's workspaces, e.g. for shared team workspaces with less-trusted members.

## Not covered

- Webviews and VS Code extensions running through the proxy (Phase 02, with `@theia/plugin-ext`).
- TLS, real DNS, NGINX/Gateway API configuration, HTTP/2, idle timeouts on long-lived WebSockets (Phase 05/16).
- Load: many sockets per gateway instance (Phase 17).
