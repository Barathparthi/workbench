# Phase 19 — (Optional) Advanced Remote Capabilities

Post-GA backlog. Each item needs its own threat-model addendum and ADR before work starts.

## 19.1 Remote agent mode (full IDE backend on the target)
- **Why**: Phase 09 remote editing has no language-server features for remote code. Agent mode runs a Theia backend (or a slim language-server host) on the target, tunneled over SSH via the broker.
- **How**: broker uploads/verifies a signed agent bundle to `~/.qe-workspace-agent/<version>/`, starts it bound to `127.0.0.1:<port>`, tunnels via `forwardOut`, router proxies the IDE to it. Theia's `@theia/remote` (Electron) is prior art — evaluate reuse.
- **Controls**: signed bundle + checksum; agent bound to loopback only; lifetime tied to session; policy capability `remote_agent`.

## 19.2 Governed port forwarding
- Use cases: open a DUT web UI or a remote debugger port.
- Design: user requests `targetId + remotePort`; policy allowlists destination ports/hosts; broker opens `forwardOut` and exposes it as an authenticated HTTP(S)/WS proxy URL `/fwd/{sessionId}/` (no raw TCP listener, no SOCKS).
- Controls: capability `port_forward` (default off), per-port allowlist, connection rate limits, audit open/close, TTL.

## 19.3 Multi-hop jump hosts and per-zone brokers
- Deploy broker replicas inside isolated lab zones; control plane routes sessions by target zone; only zone broker has egress to that zone.

## 19.4 Step-up authentication
- Require recent MFA (`auth_time`/`acr` claim) for targets tagged `privileged`; re-auth flow before session creation.

## 19.5 Session recording
- asciicast v2 recording of remote terminals to object storage with retention and access controls; banner notice; requires legal/privacy approval.

## 19.6 Other protocols
- RDP/VNC via Apache Guacamole behind the same policy/ticket model.
- Serial consoles via console servers (already works as SSH targets).

## 19.7 Collaboration
- Theia/Open Collaboration Tools for pair sessions in a shared workspace; requires workspace-member roles and audit.
