# Spike S4 — `ssh2` deep-check

Throwaway code for Phase 00 spike S4 (`02_PHASES/PHASE_00_ENVIRONMENT_DECISIONS_SPIKES.md` step 0.7).
Results: [`docs/spikes/S4_SSH2.md`](../../docs/spikes/S4_SSH2.md).

| File | What |
| --- | --- |
| `env.sh` | Local test environment (Linux, root): OpenSSH target `:2222`, bastion `:2223` (may forward only to the target), Vault dev `:8200` as SSH user CA. Keys are generated fresh under `/srv/qe-s4`. |
| `checks.mjs` | 20 checks with `ssh2` 1.17.0: host-key pinning, mismatch before auth, async verifier, certificate/agent/key auth and their negatives, jump host, forwarding refusals, PTY resize, Ctrl+C vs signal, timeouts, SFTP. |
| `patch-ssh2-certificates.mjs` | Five-line patch to `ssh2`'s `authPK()` so OpenSSH user certificates work (see the report). |

```bash
sudo apt-get install -y openssh-server openssh-client         # plus a Vault binary
npm install
VAULT=/path/to/vault ./env.sh up
node checks.mjs                       # certificate-auth fails on stock ssh2 1.17.0
node patch-ssh2-certificates.mjs      # apply the patch (idempotent; --check to verify)
./env.sh certs                        # certificates are short-lived: re-issue before re-running
node checks.mjs                       # 20/20
./env.sh down
```

`ssh2`'s optional native crypto add-on is denied in `allowScripts`; the pure-JS implementation is used.
