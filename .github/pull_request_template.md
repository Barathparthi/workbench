## What & why

<!-- Phase XX / issue link. One paragraph. -->

## Changes

-

## Security checklist

- [ ] Server-side authz on every new/changed route (permission declared)
- [ ] Input validated with Zod; size/time limits set
- [ ] No secrets/tokens/keys/terminal bytes/file contents in logs, traces, errors, fixtures
- [ ] No shell interpolation; paths confined where relevant
- [ ] Negative tests added for privileged paths
- [ ] Audit event(s) added for privileged actions

## Ops checklist

- [ ] Metrics/spans added; no high-cardinality labels
- [ ] Migration is expand/contract-safe (N-1 compatible)
- [ ] Runbook/docs updated (including `docs/PROJECT_LOG.md` and `CHANGELOG.md`)

## Evidence

```text
<real output of typecheck / lint / tests>
```

## Parity

- [ ] Behaviour checked in browser and desktop (or N/A)
