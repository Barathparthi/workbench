# Phase 18 — Pilot, Release and Rollout

| | |
|---|---|
| **Goal** | Controlled pilot → evidence-based GA |
| **Duration** | 3–4 weeks (pilot) + rollout |
| **Prerequisites** | Phases 14, 16, 17 gates PASS |
| **Prompt pack** | `03_PROMPTS/PHASE_18_PROMPTS.md` |

## Step-by-step
1. **Release candidate**: freeze scope; run `04_OPERATIONS/PRODUCTION_READINESS_CHECKLIST.md`; every item links to evidence.
2. **Pilot cohort**: 10–20 QE engineers, 3–5 lab targets, one primary repo per person. Both web and desktop users.
3. **Enablement**: 45-min demo (`04_OPERATIONS/DEMO_SCENARIO.md`), user guide, admin guide, support channel, office hours twice a week.
4. **Pilot telemetry review (weekly)**: workspace start p95, terminal/SSH failure rates, WS disconnects, resource saturation, top errors, support tickets, user survey (SUS/NPS + friction list).
5. **Fix loop**: prioritise friction & reliability fixes; release weekly through the pipeline.
6. **Go/No-Go for GA**: SLOs met 2 weeks running, no open Sev1/Sev2, security sign-off, support/on-call ready, capacity for GA headcount.
7. **Rollout waves**: team by team; add targets per lab with lab admins; communicate deprecation of personal-key lab access where applicable.
8. **Post-GA cadence**: Theia/Node upgrades (monthly/quarterly), dependency patching (weekly), quarterly access review of policies and targets, annual pen test.
9. **Ownership**: confirm named owners (IDE platform, control plane, broker, runtime images, security, infra, QE SDK).

## Exit criteria
- [ ] **Milestone M5**: GA approved; stakeholder demo passes from a clean environment.
- [ ] Final acceptance criteria (`04_OPERATIONS/FINAL_ACCEPTANCE_CRITERIA.md`) all checked with evidence.
