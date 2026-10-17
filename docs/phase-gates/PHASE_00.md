# Phase Gate — Phase 00: Environment, Decisions and Technical Spikes

**Date:** 2026-10-17 (interim record, updated after spikes S1, S2 — phase still in progress) · **Branch/PRs:**
`claude/gallant-goldberg-v788zv` · **Reviewers:** tech lead + security (not yet held)

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_00_ENVIRONMENT_DECISIONS_SPIKES.md`.

## Deliverables

| Deliverable                                               | Status                                                                               | Evidence                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `docs/ORG_DECISIONS.md`                                   | **partial** — created; kit defaults marked _Assumed_, 1 row confirmed, 6 rows _Open_ | [`ORG_DECISIONS.md`](../ORG_DECISIONS.md)                          |
| Pinned versions table with verification date              | **done** — Theia 1.76.0 pinned after S1                                              | `ORG_DECISIONS.md` §F, `.nvmrc`, `package.json`                    |
| S1 Theia browser + Electron hello app                     | **done** — same command and terminal work in both                                    | [`docs/spikes/S1_THEIA_HELLO.md`](../spikes/S1_THEIA_HELLO.md)     |
| S2 Theia behind a reverse proxy at `/w/{id}/`             | **done** — path and subdomain both work; cookie fix proven                           | [`docs/spikes/S2_REVERSE_PROXY.md`](../spikes/S2_REVERSE_PROXY.md) |
| S3 Remote terminal + remote FS approach                   | missing                                                                              | —                                                                  |
| S4 `ssh2` deep-check (host keys, certs, agent, jump host) | missing                                                                              | —                                                                  |
| S5 Open VSX extension availability                        | missing                                                                              | —                                                                  |
| ADR-005 (routing), ADR-006 (remote terminal/FS)           | ADR-005 **accepted** (path-based); ADR-006 still _Proposed_ (S3)                     | `05_ADR/ADRS.md`                                                   |
| Risk register initialised                                 | done (R1–R13 from the kit; R14–R15 added)                                            | `07_PLANNING/RISK_REGISTER.md`                                     |

## Validation (real output, trimmed)

```text
$ nvm ls-remote --lts | tail -1
       v24.22.0   (Latest LTS: Krypton)
$ npm view @theia/core dist-tags --json
{
  "testnext": "0.4.0-testnext.d1b1bc8c",
  "latest": "1.76.0",
  "patch": "1.74.2",
  "next": "1.77.0-next.57"
}
$ curl -s https://raw.githubusercontent.com/eclipse-theia/theia/v1.76.0/package.json   # excerpt
  "engines": { "node": ">=24" },
  "typescript": "~5.9.3",
$ npm view @theia/electron@1.76.0 peerDependencies --json
{
  "electron": "42.8.1"
}
```

## Security review

- Threats touched: none yet. S4 (host-key verification, certificate auth) is the security-relevant spike.

## Operational review

- n/a.

## Parity (browser / local web / desktop)

- S1: same command and terminal in browser and Electron. S2: browser through a path and a subdomain proxy (Electron is unaffected by routing).

## Known limitations & follow-ups

- Sections A–E need answers from IdP, platform, security and network owners (step 0.2).
- Remaining spikes need: Docker or a Linux test VM (S2, S4), a Vault dev server (S4), Theia (S3, reuse the S1 apps).
- S1 added org decision D12 (build-time access to `artifacts.electronjs.org` or a mirror) and the Linux build packages to §F.
- Phase 01 was built before this gate (risk R15); nothing in Phase 01 depends on spike outcomes.

## Decision

- [ ] PASS - [ ] CONDITIONAL - [ ] FAIL — **not gated yet** (in progress).
