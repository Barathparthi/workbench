# Stakeholder Demo Scenario (≈ 20 minutes)

**Cast:** Priya (QE engineer), Meera (lab admin). **Workspace:** `login-automation` (pytest). **Target:** `qe-linux-01` (disposable lab VM).

## Part A — Web (8 min)
1. Open `https://qe-workspace.<corp>` → SSO → workspace list.
2. Start `login-automation` → IDE loads (show start time).
3. Open `tests/test_login.py`, change an assertion, save.
4. Terminal: `python -m pytest -q` → live output; run `sleep 100`, press Ctrl+C.
5. QE panel → Run all → results tree (1 failure) → click failure → jumps to line → fix → re-run green → open HTML report.

## Part B — Connect to another system (6 min)
6. Remote Connections → `qe-linux-01` (only Priya's allowed targets visible).
7. Connect → terminal header shows verified host-key fingerprint → `hostname; whoami` (whoami = priya via SSH certificate principal).
8. Open Remote Folder → edit `config/env.yaml` → save → `cat` it in the remote terminal.
9. Try to open `../../etc/passwd` via the API (curl with Priya's session) → `PATH_OUTSIDE_ROOT`.
10. Disconnect.

## Part C — Local (3 min)
11. Launch desktop app → open the same repo locally → same QE commands/panel → connect to the same managed target (signed in) and to a personal target from `~/.ssh/config`.

## Part D — Governance (3 min)
12. Meera opens Audit view → filter Priya → shows workspace start, connect allowed, SSH opened/closed, remote file write, test runs (no secrets in metadata).
13. Show a user without lab access: target not listed; direct API connect → 403; broker received no connection.
14. Browser DevTools → Application/Storage/Network: no private key, no ticket reuse possible.

## Expected evidence
Live output, Ctrl+C works, results parsed, remote edit confined, host key verified, audit complete, unauthorized blocked, desktop parity.
