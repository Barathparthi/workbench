# Final Acceptance Criteria

The release is production-capable only when every line is demonstrably true (link evidence).

## Core IDE (all modes)
- [ ] Browser IDE over HTTPS (hosted) and localhost (local web); Electron desktop on 3 OSes
- [ ] Editor, explorer, search, Git, approved extensions work identically (parity suite)
- [ ] Workspace open within agreed latency; saves durable across restarts

## Execution
- [ ] Interactive terminal (REPL, vim, top), resize, Ctrl+C, exit codes
- [ ] Commands run in the intended runtime; resource limits enforced; cleanup verified

## Remote connections
- [ ] Targets centrally registered with SSRF validation and approved host keys
- [ ] Authorization before any network attempt (tested: no SYN for unauthorized)
- [ ] Credentials server-side only; short-lived certificates
- [ ] Remote terminal and remote file editing within `remoteRoot`
- [ ] Idle/absolute timeouts and revocation work; all events audited
- [ ] Desktop/local personal targets via user's agent and known_hosts

## QE
- [ ] Representative framework runs locally and remotely; live output; parsed results; reports; cancel

## Security & operations
- [ ] All items in PRODUCTION_READINESS_CHECKLIST.md evidenced
- [ ] Stakeholder demo (DEMO_SCENARIO.md) passes from a clean environment
- [ ] Production approval recorded
