# Phase Gate — Phase 00: Environment, Decisions and Technical Spikes

**Date:** 2026-10-17 (all five spikes done; gate proposed CONDITIONAL) · **Branch/PRs:**
`claude/gallant-goldberg-v788zv`, PRs #1–#5 · **Reviewers:** tech lead + security (review not yet held)

Template: `06_TEMPLATES/PHASE_GATE_TEMPLATE.md`. Guide: `02_PHASES/PHASE_00_ENVIRONMENT_DECISIONS_SPIKES.md`.

## Deliverables

| Deliverable                                               | Status                                                                               | Evidence                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `docs/ORG_DECISIONS.md`                                   | **partial** — created; kit defaults marked _Assumed_, 1 row confirmed, 6 rows _Open_ | [`ORG_DECISIONS.md`](../ORG_DECISIONS.md)                                    |
| Pinned versions table with verification date              | **done** — Theia 1.76.0 pinned after S1                                              | `ORG_DECISIONS.md` §F, `.nvmrc`, `package.json`                              |
| S1 Theia browser + Electron hello app                     | **done** — same command and terminal work in both                                    | [`docs/spikes/S1_THEIA_HELLO.md`](../spikes/S1_THEIA_HELLO.md)               |
| S2 Theia behind a reverse proxy at `/w/{id}/`             | **done** — path and subdomain both work; cookie fix proven                           | [`docs/spikes/S2_REVERSE_PROXY.md`](../spikes/S2_REVERSE_PROXY.md)           |
| S3 Remote terminal + remote FS approach                   | **done** — option B passes in browser and Electron; option A cannot run in Electron  | [`docs/spikes/S3_REMOTE_TERMINAL_FS.md`](../spikes/S3_REMOTE_TERMINAL_FS.md) |
| S4 `ssh2` deep-check (host keys, certs, agent, jump host) | **done** — 20/20 with a 5-line ssh2 patch for certificates                           | [`docs/spikes/S4_SSH2.md`](../spikes/S4_SSH2.md)                             |
| S5 Open VSX extension availability                        | **done** — all required available and compatible; Pylance → basedpyright             | [`docs/spikes/S5_OPEN_VSX.md`](../spikes/S5_OPEN_VSX.md)                     |
| ADR-005 (routing), ADR-006 (remote terminal/FS)           | both **accepted** (path-based; Theia frontend extension) — ratify in PR review       | `05_ADR/ADRS.md`                                                             |
| Risk register initialised                                 | done (R1–R13 from the kit; R14–R17 added; R1–R4 updated by spikes)                   | `07_PLANNING/RISK_REGISTER.md`                                               |

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

- Threats touched: host-key spoofing / MITM (S4: pinned SHA256 verification fails closed before credentials are sent; `ssh2`'s default accept-all must be blocked by `SshTransport`), credential theft (S4: short-lived Vault certificates, rejected when expired or for the wrong principal), lateral movement via forwarding (S4: target and bastion refuse forwarding outside policy), cross-workspace session confusion (S2: connection-token cookie collision and its gateway fix), SSH reachability
  from the runtime (S3: both prototypes reach the broker from the page, never from the Theia backend; ADR-006
  keeps it that way), WebSocket hijacking (S3: the Electron renderer's `Origin` is `file://`, so the desktop must
  relay through its backend with a Bearer token — R17, contract addendum in Phase 08).

## Operational review

- n/a.

## Parity (browser / local web / desktop)

- S1: same command and terminal in browser and Electron. S2: browser through a path and a subdomain proxy (Electron is unaffected by routing).
- S3: the chosen remote terminal/FS approach (option B) passes the same checks in browser and Electron; the
  public-API alternative (VS Code web extension) does not run in Electron at all, which decided ADR-006.

## Known limitations & follow-ups

- Sections A–E need answers from IdP, platform, security and network owners (step 0.2).
- Spikes ran in this container (OpenSSH, Vault dev server, Theia apps); S2 used Node proxies instead of the
  production gateway, S3 a stub broker without authentication — both are re-verified with the real components
  in Phases 05 and 08.
- Step 0.9 (roadmap update with spike learnings, 1-hour architecture review) is still to do.
- S1 added org decision D12 (build-time access to `artifacts.electronjs.org` or a mirror) and the Linux build packages to §F.
- Phase 01 was built before this gate (risk R15); nothing in Phase 01 depends on spike outcomes.

## Decision

- [ ] PASS
- [x] **CONDITIONAL** (proposed 2026-10-17; the reviewers confirm or change it in the PR review). Met: versions
      pinned; S1–S5 reports written; ADR-005 and ADR-006 accepted. Not met, so these are the conditions:
  1. **Org decisions** — `ORG_DECISIONS.md` is not 90% confirmed: most rows are kit defaults marked _Assumed_,
     and B1, C1, C6, D1, D9, D12 are _Open_; A8 needs a licence review. Owner: project owner, who routes them to
     the IdP, platform, security, network and legal owners. Due: each row before the phase it blocks (D12 before
     the Phase 02 desktop CI; D1, D9 before Phase 05; C1, C6 before Phase 07; B1 before Phase 12).
  2. **Architecture review and sign-off** (architecture doc + ADRs + risks, step 0.9) by the tech lead and
     security. Owner: project owner. Due: before Phase 05 (the first phase that deploys runtimes); Phase 02–04
     do not depend on the open items.
- [ ] FAIL
