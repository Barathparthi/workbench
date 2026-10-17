# QE Workspace — Admin Guide (draft)

## Roles
`qe.user`, `qe.lead`, `lab.<name>.user`, `qe.admin`, `auditor` — mapped from IdP groups in `ROLE_MAPPINGS`.

## Onboard a lab target
1. Prepare target: OpenSSH server; run `scripts/target-onboard.sh` (installs user CA public key into `TrustedUserCAKeys`, sets `AuthorizedPrincipalsFile` if used, creates per-user accounts or service account).
2. Create/choose a **policy**: allowed roles, CIDRs, ports, capabilities (terminal, file_read, file_write, exec), timeouts, session caps.
3. **Register target**: name, host, port, OS, principal template, remoteRoot, policy, credential method.
4. **Approve host key**: paste fingerprint from console/CMDB, or *Scan* and compare out-of-band. Never approve unverified keys.
5. **Test connection** → status *active*.

## Day-2
- Rotate host key: approve new → revoke old.
- Revoke a user: Admin → Users → Revoke sessions (also disable in IdP).
- Review access quarterly: export policies and members; remove stale grants.
- Audit: filter by user/target/time; export CSV for investigations.

## Workspace administration
- Templates: image digest, default profile, extensions list.
- Quotas & profiles: CPU/memory/disk, idle stop minutes, max running per user.

## Safety rules
- Do not enable `port_forward` or `exec` broadly; prefer per-lab policies.
- Never register management/production control-plane networks as targets.
- Any host-key mismatch → follow RB-04.
