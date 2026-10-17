# 90 — Utility Prompts

## U1 — Debug a failing test
```text
Test <name> fails with: <paste output>. Do not change the test's assertions yet.
1) Reproduce it and show the exact command. 2) Explain the root cause with file:line evidence.
3) Propose the minimal fix in product code. 4) Only if the test itself is wrong, explain why with
reference to the spec/contract and propose the corrected assertion. Then implement and re-run.
```

## U2 — CI is red
```text
CI job <job> failed. Logs: <paste>. Identify the failing step, reproduce locally with the same command
and Node version (.nvmrc), find the root cause, fix it. Do not disable the job, add continue-on-error,
or skip tests.
```

## U3 — Flaky test
```text
Test <name> is flaky (fails ~N%). Run it 50 times, collect failures, identify the nondeterminism
(timing, ordering, shared state, ports, real clock). Replace sleeps with explicit waits/conditions,
isolate state, use fake timers where appropriate. Show 50/50 green afterwards.
```

## U4 — Focused security review of a diff
```text
Review the diff for <feature> strictly for security against threats T1–T23 in
docs/architecture/07_SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md. For each relevant threat say: control
present? test present? gap? Output findings table first; propose tests that prove each control.
```

## U5 — Add an endpoint the right way
```text
Add <METHOD> <path> per docs/architecture/05_API_CONTRACTS.md: Zod request/response schemas in
packages/contracts, route config {permission, audit, rateLimit}, service method with resource-scoped
authz, audit event from the catalogue, metric if relevant, unit + integration + authz-matrix entries,
OpenAPI regenerated. No other changes.
```

## U6 — Add an audit event
```text
Add audit action <ACTION> emitted when <condition>. Add it to the catalogue with an explicit metadata
allowlist (no secrets/content). Emit from <service>. Add a test asserting the event with actor, resource,
result, reasonCode. Ensure failure to write the audit event fails the privileged action.
```

## U7 — Upgrade Theia
```text
Upgrade all @theia/* packages from <old> to <new> together. First read the Theia changelog breaking
changes between these versions and list those affecting our extensions. Then update versions, rebuild
browser and electron apps, fix compile errors, run unit + E2E + parity suites, and report changes in
behaviour. Do not mix other dependency upgrades into this change.
```

## U8 — Performance investigation
```text
Metric <name> regressed (<numbers>). Using traces/metrics/profiles, find where time is spent. Propose
hypotheses ranked by evidence, test the top one with a measurement, implement the fix, and show
before/after numbers from the same load test.
```

## U9 — Incident analysis
```text
Incident: <symptoms, times>. Using logs (by traceId/sessionId), metrics and audit events, build a
timeline, identify the triggering change/condition, the blast radius, and the root cause. Propose
remediation (immediate, short-term, long-term) and tests/alerts that would have caught it earlier.
Write it as a blameless postmortem draft.
```

## U10 — Explain code to a new team member (KT)
```text
Explain <package/feature> to a new engineer: purpose, main types, request flow (with file:line),
security controls involved, how to run its tests, common pitfalls. Keep it under 1 page.
```

## U11 — Write a runbook
```text
Write a runbook for alert <name>: what it means, impact, dashboards/queries to check, decision tree,
mitigation commands (kubectl/helm/API), escalation, and how to verify recovery. Use only commands that
exist in this repo/deployment.
```

## U12 — Pre-PR checklist
```text
Before I open a PR: list files changed; confirm no secrets/keys/test credentials committed; confirm no
`any`, ts-ignore or eslint-disable without justification; confirm tests added for each behaviour;
run typecheck/lint/unit/integration and paste results; draft the PR description from the template.
```
