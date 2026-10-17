# Org Decisions — QE Workspace

Filled from `00_START_HERE/03_DECISIONS_BEFORE_CODING.md`. Code must not guess these values.

**Status legend**

- **Confirmed** — a fact or decision with a named source.
- **Assumed** — the kit default, used so work can proceed; it must be confirmed or replaced by the owner.
- **Open** — no workable default; blocks the phase listed.

Last reviewed: 2026-10-17 (Phase 00, after spike S1). Revisit at every milestone.

## A. Product scope

| #   | Question                    | Answer                                                                                                                                                                                                                                                                                                                                                                                        | Status    | Owner          |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- |
| A1  | Users                       | QE/SDET employees only                                                                                                                                                                                                                                                                                                                                                                        | Assumed   | TBD            |
| A2  | Users at pilot / GA         | 20 pilot / 150 GA                                                                                                                                                                                                                                                                                                                                                                             | Assumed   | TBD            |
| A3  | Peak concurrent workspaces  | 40 % of users                                                                                                                                                                                                                                                                                                                                                                                 | Assumed   | TBD            |
| A4  | Modes at GA                 | Hosted web, local web, desktop (desktop may be GA+1)                                                                                                                                                                                                                                                                                                                                          | Assumed   | TBD            |
| A5  | Desktop OSes                | Windows 11, macOS 14+, Ubuntu 22.04+                                                                                                                                                                                                                                                                                                                                                          | Assumed   | TBD            |
| A6  | Workspace image toolchains  | Python 3.12, Java 21 + Maven, Node LTS, Git                                                                                                                                                                                                                                                                                                                                                   | Assumed   | TBD            |
| A7  | First test framework        | pytest (JUnit XML), then Maven Surefire                                                                                                                                                                                                                                                                                                                                                       | Assumed   | TBD            |
| A8  | Required VS Code extensions | Proposed allowlist from spike S5: `ms-python.python`, `ms-python.debugpy`, `detachhead.basedpyright` (replaces Pylance — not on Open VSX), `charliermarsh.ruff`, `redhat.java` + `vscjava.*` (debug, test, maven), `redhat.vscode-yaml`, `d-biehl.robotcode`, built-in `vscode.git`; all on Open VSX and Theia 1.76-compatible; licence review pending for some ([S5](spikes/S5_OPEN_VSX.md)) | Assumed   | QE rep + legal |
| A9  | Git hosting                 | GitHub (this repository: `barathparthi/workbench`)                                                                                                                                                                                                                                                                                                                                            | Confirmed | —              |

## B. Identity & access

| #   | Question                        | Answer                                                       | Status  | Blocks   |
| --- | ------------------------------- | ------------------------------------------------------------ | ------- | -------- |
| B1  | Corporate IdP                   | Any OIDC-compliant IdP; Keycloak in the dev stack            | Open    | Phase 12 |
| B2  | Group claims → roles            | `qe-workspace-users`, `qe-workspace-admins`, `qe-lab-<name>` | Assumed | Phase 04 |
| B3  | Session lifetime / idle timeout | 8 h absolute, 30 min idle (UI), terminals 2 h idle           | Assumed | Phase 04 |
| B4  | MFA / step-up                   | MFA via IdP; step-up optional (Phase 19)                     | Assumed | Phase 12 |
| B5  | Break-glass admin procedure     | Documented, audited, 2-person                                | Assumed | Phase 12 |

## C. Remote systems

| #   | Question                                     | Answer                                                     | Status  | Blocks   |
| --- | -------------------------------------------- | ---------------------------------------------------------- | ------- | -------- |
| C1  | Target inventory (count, OS, zone)           | Linux lab VMs + some Windows OpenSSH hosts                 | Open    | Phase 07 |
| C2  | How users authenticate today                 | Personal keys (to be replaced)                             | Assumed | —        |
| C3  | Target auth at GA                            | SSH certificates (Vault SSH CA), fallback vault-stored key | Assumed | Phase 12 |
| C4  | Host-key trust source                        | Pinned SHA256 fingerprints, host CA later                  | Assumed | Phase 08 |
| C5  | Bastion / jump host                          | Yes for lab zone B (Phase 19)                              | Assumed | Phase 19 |
| C6  | CIDRs/ports the broker may reach             | Lab CIDRs only, port 22 — actual CIDRs needed              | Open    | Phase 07 |
| C7  | Port forwarding                              | Disabled at GA; governed in Phase 19                       | Assumed | —        |
| C8  | Session recording                            | Metadata audit only; recording optional                    | Assumed | Phase 12 |
| C9  | Desktop: personal hosts from `~/.ssh/config` | Yes; managed targets via broker                            | Assumed | Phase 10 |
| C10 | Other protocols (RDP/VNC/serial)             | Out of scope                                               | Assumed | —        |

## D. Platform & infrastructure

| #   | Question                            | Answer                                                                                                                                                                                        | Status  | Blocks              |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------- |
| D1  | Kubernetes platform                 | Any CNCF-conformant, supported minor                                                                                                                                                          | Open    | Phase 05            |
| D2  | Ingress / gateway controller        | NGINX Ingress or a Gateway API implementation                                                                                                                                                 | Assumed | Phase 16            |
| D3  | Storage class for workspace volumes | CSI RWO with snapshots                                                                                                                                                                        | Assumed | Phase 05            |
| D4  | PostgreSQL                          | Managed service (RDS / Azure DB / Cloud SQL)                                                                                                                                                  | Assumed | Phase 03            |
| D5  | Secret manager                      | HashiCorp Vault (SSH CA support)                                                                                                                                                              | Assumed | Phase 12            |
| D6  | Registry & signing                  | Internal registry + cosign                                                                                                                                                                    | Assumed | Phase 15            |
| D7  | Internal Open VSX mirror            | Yes, allowlisted extensions only                                                                                                                                                              | Assumed | Phase 02            |
| D8  | Workspace egress                    | Deny by default; allow Artifactory/Nexus and Git host                                                                                                                                         | Assumed | Phase 16            |
| D9  | Hosted DNS name and certificates    | `qe-workspace.<corp-domain>` plus wildcard DNS + TLS `*.webview.qe-workspace.<corp-domain>` for webview origins (ADR-005, S2)                                                                 | Open    | Phase 05/16         |
| D10 | Telemetry backend                   | OTLP to the org collector                                                                                                                                                                     | Assumed | Phase 13            |
| D11 | CI system                           | GitHub Actions (repository is on GitHub; `ci.yml` added)                                                                                                                                      | Assumed | —                   |
| D12 | Build-time network access           | `registry.npmjs.org`, `github.com` (Electron binary) and `artifacts.electronjs.org` (Electron headers for native rebuilds) — or internal mirrors via `npm_config_disturl` / `ELECTRON_MIRROR` | Open    | Phase 02 desktop CI |

## E. Compliance & operations

| #   | Question                   | Answer                                     | Status  |
| --- | -------------------------- | ------------------------------------------ | ------- |
| E1  | Audit retention            | 1 year hot, 7 years archive (check policy) | Assumed |
| E2  | Source code classification | Internal/confidential                      | Assumed |
| E3  | Security reviews           | Threat model and pentest before GA         | Assumed |
| E4  | Availability target        | 99.5 % pilot, 99.9 % GA (business hours)   | Assumed |
| E5  | RPO / RTO                  | RPO 24 h (snapshots), RTO 4 h              | Assumed |
| E6  | On-call model              | Business-hours on-call during pilot        | Assumed |
| E7  | Change management          | Pipeline approval gate                     | Assumed |

## F. Toolchain (pinned 2026-10-17)

Verified on 2026-10-17 against the npm registry (`npm view`), the Node.js release index (`nvm ls-remote
--lts`) and Theia's repository at tag `v1.76.0`.

| Item                 | Pinned value                                      | Where it is pinned                               | Source / rationale                                                                                                         |
| -------------------- | ------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Node.js              | **24.22.0** (engines `>=24.11.0 <25`)             | `.nvmrc`, root `package.json` `engines`          | Latest Active LTS ("Krypton"); Theia 1.76.0 root `package.json` declares `"node": ">=24"`                                  |
| npm                  | 11.19.1 (engines `>=11`)                          | bundled with Node 24.22.0                        | Version shipped with the pinned Node                                                                                       |
| TypeScript           | **5.9.3**                                         | root `devDependencies`                           | Theia 1.76.0 and 1.74.2 both use `~5.9.3`; TypeScript 6/7 not adopted (typescript-eslint supports `<6.1.0`)                |
| Theia                | **1.76.0** (2026-09-24) — pinned after spike S1   | `spikes/s1-theia-hello`; Phase 02 apps           | Built and ran in browser and Electron with no Theia workarounds ([S1 report](spikes/S1_THEIA_HELLO.md)). 1.74.2 not needed |
| Electron             | 42.8.1                                            | Phase 02 (`apps/ide-electron`)                   | `peerDependencies` of `@theia/electron@1.76.0`; verified in S1 under `xvfb`                                                |
| Linux build packages | `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev` | developer prerequisites, CI, runtime build image | `native-keymap` and `keytar` compile from source (S1 finding 2)                                                            |
| PostgreSQL           | Open — supported major of the managed service     | Phase 03                                         | Depends on D4                                                                                                              |
| Kubernetes           | Open — supported minor of the platform            | Phase 05                                         | Depends on D1                                                                                                              |
| Base images          | Open — org-approved, pinned by digest             | Phase 05 / 15                                    | —                                                                                                                          |

Development tooling (exact versions in `package.json`): ESLint 10.13.0, typescript-eslint 8.71.2,
eslint-plugin-boundaries 7.2.0, eslint-import-resolver-typescript 4.4.5, Prettier 3.9.10,
Vitest 5.0.5 (+ `@vitest/coverage-v8`), `@types/node` 24.19.2.
GitHub Actions: `actions/checkout` v7.0.1 (`3d3c42e5…`), `actions/setup-node` v7.1.0 (`949feb24…`).
