# Manifest — QE Workspace Implementation Kit v2

| Path | Purpose |
|---|---|
| `README.md` | Overview, modes, phase table, milestones, rules |
| `00_START_HERE/01_EXECUTIVE_SUMMARY.md` | One-page picture for sponsors |
| `00_START_HERE/02_HOW_TO_USE_THIS_KIT.md` | Human + AI agent workflow |
| `00_START_HERE/03_DECISIONS_BEFORE_CODING.md` | Org inputs questionnaire |
| `00_START_HERE/04_GLOSSARY.md` | Terms |
| `01_ARCHITECTURE/01_PRODUCT_REQUIREMENTS.md` | PRD, user stories, NFRs/SLOs |
| `01_ARCHITECTURE/02_SOLUTION_ARCHITECTURE.md` | Components, flows, state machines, scaling |
| `01_ARCHITECTURE/03_TECH_STACK_AND_VERSIONS.md` | Stack, version policy, spike checklist |
| `01_ARCHITECTURE/04_REPO_STRUCTURE_AND_STANDARDS.md` | Monorepo layout, boundaries, standards |
| `01_ARCHITECTURE/05_API_CONTRACTS.md` | REST, WS protocol qews.v1, errors, internal API |
| `01_ARCHITECTURE/06_DATA_MODEL.md` | PostgreSQL DDL, audit catalogue, retention |
| `01_ARCHITECTURE/07_SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md` | Threats T1–T23, controls, gates |
| `01_ARCHITECTURE/08_REMOTE_CONNECTIVITY_DESIGN.md` | SSH design: managed/personal targets, certs, host keys, jump hosts, remote FS |
| `01_ARCHITECTURE/09_LOCAL_AND_WEB_PARITY.md` | How local and web stay identical |
| `01_ARCHITECTURE/10_OBSERVABILITY.md` | Traces, metrics, dashboards, alerts, SLOs |
| `01_ARCHITECTURE/11_TESTING_STRATEGY.md` | Test pyramid, fixtures, security/E2E/load |
| `01_ARCHITECTURE/12_CICD_AND_RELEASE.md` | Pipeline, images, signing, rollout, rollback |
| `02_PHASES/PHASE_00 … PHASE_19` | 20 step-by-step phase guides |
| `03_PROMPTS/00_SESSION_BOOTSTRAP_PROMPT.md` | Paste at start of every agent session |
| `03_PROMPTS/01_STANDARD_8_STEP_LOOP.md` | Inspect → Plan → Implement → Review → Fix → Validate → Document → Gate |
| `03_PROMPTS/PHASE_00_PROMPTS … PHASE_19_PROMPTS` | Per-phase prompt packs (context + one prompt per step) |
| `03_PROMPTS/90_UTILITY_PROMPTS.md` | Debug, CI, flaky, security review, Theia upgrade, incident, KT |
| `04_OPERATIONS/RUNBOOKS.md` | 13 runbooks |
| `04_OPERATIONS/PRODUCTION_READINESS_CHECKLIST.md` | Evidence-based go-live checklist |
| `04_OPERATIONS/FINAL_ACCEPTANCE_CRITERIA.md` | Release acceptance |
| `04_OPERATIONS/DEMO_SCENARIO.md` | 20-minute stakeholder demo |
| `04_OPERATIONS/USER_GUIDE.md`, `ADMIN_GUIDE.md` | Draft end-user and admin docs |
| `05_ADR/ADR_INDEX.md`, `ADRS.md` | ADR-001 … ADR-010 |
| `06_TEMPLATES/*` | CLAUDE.md, AGENTS.md, PR template, phase gate, ADR template, CODEOWNERS/config snippets |
| `07_PLANNING/*` | Roadmap/timeline, team & RACI, risk register |
| `reference/QE_Web_Development_Workbench_Technical_Architecture.docx` | Original architecture spec |
