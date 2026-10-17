# 03 — Decisions to Make Before Coding

These are **organization inputs**. Code must not guess them. Fill in every row with the owning team,
commit this file as `docs/ORG_DECISIONS.md`, and revisit at each milestone.

Legend: **Default** = what this kit assumes if you have no stronger requirement.

---

## A. Product scope

| # | Question | Answer | Default |
|---|---|---|---|
| A1 | Who are the users? (QE engineers, SDETs, devs, contractors?) | | QE/SDET employees only |
| A2 | How many users at pilot / at GA? | | 20 pilot / 150 GA |
| A3 | Peak concurrent workspaces? | | 40% of users |
| A4 | Which modes at GA? Hosted web / local web / desktop | | All three; desktop may be GA+1 |
| A5 | Which OSes must desktop support? | | Windows 11, macOS 14+, Ubuntu 22.04+ |
| A6 | Which languages/toolchains must the workspace image include? | | Python 3.12, Java 21 + Maven, Node LTS, Git |
| A7 | Primary test framework(s) for the QE runner? | | pytest (JUnit XML) first, then Maven Surefire |
| A8 | Which VS Code extensions are required? | | Python, Java, YAML, GitLens-alternative, Robot Framework (if used) |
| A9 | Is Git hosted on GitHub / GitLab / Bitbucket / Azure DevOps? | | — |

## B. Identity & access

| # | Question | Answer | Default |
|---|---|---|---|
| B1 | Corporate IdP (Entra ID / Okta / Keycloak / Ping / ADFS)? | | OIDC-compliant IdP |
| B2 | Which group claims drive roles? | | `qe-workspace-users`, `qe-workspace-admins`, `qe-lab-<name>` |
| B3 | Session lifetime / idle timeout policy? | | 8h absolute, 30 min idle (UI), terminals 2h idle |
| B4 | MFA required? Step-up for privileged targets? | | MFA via IdP; step-up optional (Phase 19) |
| B5 | Break-glass admin procedure? | | Documented, audited, 2-person |

## C. Remote systems ("connect to other systems")

| # | Question | Answer | Default |
|---|---|---|---|
| C1 | Inventory of target systems (count, OS, network zone) | | Linux lab VMs + some Windows OpenSSH hosts |
| C2 | How do users authenticate to targets today? | | Personal keys (to be replaced) |
| C3 | Target auth at GA: SSH certificates (Vault SSH CA) / per-target key in vault / password in vault? | | **SSH certificates**, fallback vault-stored key |
| C4 | Host-key trust source: SSH host CA / pinned fingerprints / CMDB? | | Pinned SHA256 fingerprints, host CA later |
| C5 | Bastion/jump host required for some zones? | | Yes for lab zone B (Phase 19) |
| C6 | Allowed CIDRs/ports the broker may reach | | Lab CIDRs only, port 22 |
| C7 | Is port forwarding needed? (e.g. reach a web UI on a DUT) | | Disabled at GA; governed in Phase 19 |
| C8 | Session recording required by compliance? | | Metadata audit only; recording optional |
| C9 | In **desktop mode**, may users connect to personal hosts from `~/.ssh/config`? | | Yes (it's their machine), managed targets via broker |
| C10 | Other protocols needed (RDP/VNC/serial console)? | | Out of scope; see Phase 19 notes |

## D. Platform & infrastructure

| # | Question | Answer | Default |
|---|---|---|---|
| D1 | Kubernetes platform (AKS/EKS/GKE/OpenShift/Rancher/on-prem)? | | Any CNCF-conformant, supported minor |
| D2 | Ingress / gateway controller? | | NGINX Ingress or Gateway API implementation |
| D3 | Storage class for workspace volumes (RWO, snapshot support)? | | CSI RWO with snapshots |
| D4 | PostgreSQL: managed service or in-cluster operator? | | Managed (RDS/Azure DB/Cloud SQL) |
| D5 | Secret manager (Vault / Azure Key Vault / AWS SM / GCP SM)? | | HashiCorp Vault (SSH CA support) |
| D6 | Container registry & signing (cosign/Notation)? | | Internal registry + cosign |
| D7 | Internal Open VSX mirror for extensions? | | Yes, allowlisted extensions only |
| D8 | Egress from workspaces: internet allowed? package mirrors? | | Deny by default; allow Artifactory/Nexus, Git host |
| D9 | DNS name for hosted mode | | `qe-workspace.<corp-domain>` |
| D10 | Telemetry backend (Grafana stack / Datadog / Splunk / Elastic / Azure Monitor)? | | OTLP to org collector |
| D11 | CI system (GitHub Actions / GitLab CI / Azure DevOps / Jenkins)? | | GitHub Actions (examples) |

## E. Compliance & operations

| # | Question | Answer | Default |
|---|---|---|---|
| E1 | Audit retention period? | | 1 year hot, 7 years archive (check policy) |
| E2 | Data classification of source code in workspaces? | | Internal/confidential |
| E3 | Required security reviews (threat model, pentest)? | | Both before GA |
| E4 | Availability target (control plane)? | | 99.5% pilot, 99.9% GA (business hours) |
| E5 | RPO / RTO for workspace data? | | RPO 24h (snapshots), RTO 4h |
| E6 | On-call model? | | Business-hours on-call during pilot |
| E7 | Change management / CAB for prod deploys? | | Pipeline approval gate |

## F. Toolchain (pin after Phase 00 spike)

| Item | Pinned value | Notes |
|---|---|---|
| Node.js | | Choose an **Active LTS** line supported by your pinned Theia release |
| npm | | Use the version bundled with the Node LTS; enable `engine-strict` |
| Theia | | Latest stable *community* release at project start; upgrade monthly or quarterly |
| Electron | | The version required by the pinned `@theia/electron` |
| TypeScript | | The version used by the pinned Theia release |
| PostgreSQL | | A currently supported major (managed service default) |
| Kubernetes | | Supported minor of your platform |
| Base images | | Org-approved distroless/UBI/Debian-slim, pinned by digest |

> Verify every version against the vendor's support page on the day you pin it. Record the date.
