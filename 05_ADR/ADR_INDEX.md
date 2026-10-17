# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| ADR-001 | Use Eclipse Theia as the IDE platform for browser and desktop | Accepted |
| ADR-002 | Broker SSH from a trusted backend; browser never holds credentials | Accepted |
| ADR-003 | Modular monolith: control plane + broker + runtimes, not many microservices | Accepted |
| ADR-004 | One workspace runtime pod per workspace on Kubernetes (Docker for local/dev) | Accepted |
| ADR-005 | Workspace routing: path-based `/w/{id}/` (subdomain rejected for v1) | Accepted (2026-10-17, spike S2; ratify in PR) |
| ADR-006 | Remote terminal & remote FS in Theia: frontend extension (terminal widget + FileServiceContribution), not a VS Code plugin | Accepted (2026-10-17, spike S3; ratify in PR) |
| ADR-007 | Short-lived SSH certificates via Vault SSH CA as default credential | Accepted (pending org Vault) |
| ADR-008 | Shared broker-core library for hosted and embedded (local) brokers | Accepted |
| ADR-009 | npm workspaces as package manager | Accepted |
| ADR-010 | Internal Open VSX mirror with allowlist for extensions | Accepted |
| ADR-011 | Workspace package conventions: ESM, `@qe/source` export condition, declared dependency graph | Accepted (2026-10-17, ratify in Phase 01 PR) |

All ADRs are in `ADRS.md`. New ADRs use `06_TEMPLATES/ADR_TEMPLATE.md`.
