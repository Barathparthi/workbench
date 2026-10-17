# Risk Register (initial)

| ID | Risk | Likelihood | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|
| R1 | Theia base-path routing or webview origins harder than expected | M | H | Spike S2; subdomain fallback (ADR-005) | Tech lead | Open |
| R2 | Remote terminal/FS integration relies on unstable Theia internals | M | M | Spike S3; prefer public APIs; contract tests; pin versions | IDE eng | Open |
| R3 | ssh2 certificate auth limitations | M | M | Spike S4; agent shim; vault_key fallback | Backend | Open |
| R4 | Required VS Code extensions missing on Open VSX (e.g. Pylance) | H | M | Spike S5; open alternatives; communicate early | IDE eng | Open |
| R5 | Org Vault / SSH CA not available in time | M | H | Start with vault_key; parallel request to platform team | Platform | Open |
| R6 | Lab targets can't trust a user CA quickly (many owners) | H | M | Onboarding script; per-lab waves; shared-account interim policy | QE rep | Open |
| R7 | Workspace cold start too slow | M | M | Image pre-pull DaemonSet, smaller images, resume from STOPPED | Platform | Open |
| R8 | Cluster cost for workspaces | M | M | Idle stop, quotas, right-sized profiles, usage reports | Platform | Open |
| R9 | Electron native module builds on Windows/macOS signing | M | M | CI matrix early (P02), signing certs requested in P00 | IDE eng | Open |
| R10 | Security review late finds design issues | L | H | Reviews at each security-sensitive phase; threat model from day 1 | Security | Open |
| R11 | Users keep personal keys/VS Code habits; low adoption | M | M | Desktop + local web parity, pilot feedback, migration guide | QE rep | Open |
| R12 | Network zones block broker → lab connectivity | M | H | Confirm firewall rules in P00; zone brokers (P19) | Platform | Open |
| R13 | Theia upgrade breaks extensions mid-project | M | M | Freeze version until after M3; scheduled upgrades with full E2E | Tech lead | Open |
