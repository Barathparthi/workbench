# 02 — How to Use This Kit

This kit is used by **two kinds of readers at the same time**:

- **Humans** (tech lead, engineers, security, platform) read `01_ARCHITECTURE/` and `02_PHASES/` to
  understand *what* to build and *how to verify it*.
- **AI coding agents** (Claude Code, Copilot agent, Cursor, etc.) are driven with `03_PROMPTS/` to
  *write the code*, one small, reviewable step at a time.

The human is always the reviewer and decision-maker. The agent never decides scope or weakens security.

---

## 1. One-time setup

1. Create the product repository (e.g. `qe-workspace`) — Phase 01 does this.
2. Copy `06_TEMPLATES/CLAUDE.md` (and/or `AGENTS.md`) into the repo root. Agents read it automatically
   and get the non-negotiable rules on every session.
3. Copy `01_ARCHITECTURE/` into `docs/architecture/` and `05_ADR/` into `docs/adr/` of the repo so the
   agent can read them as files instead of you pasting them.
4. Fill in `00_START_HERE/03_DECISIONS_BEFORE_CODING.md` and commit it as `docs/ORG_DECISIONS.md`.

## 2. The rhythm for every phase

```text
 Read phase guide (human) ──► Bootstrap agent session ──► 8-step prompt loop ──► Phase gate (human)
        02_PHASES/PHASE_xx      03_PROMPTS/00_…             03_PROMPTS/01_… +       06_TEMPLATES/
                                                            PHASE_xx prompt pack     PHASE_GATE_TEMPLATE
```

### Step-by-step

1. **Human reads** `02_PHASES/PHASE_xx_*.md` end-to-end. Confirm prerequisites are met.
2. **Create a branch**: `git switch -c phase-xx-<short-name>`.
3. **Start a fresh agent session** and paste `03_PROMPTS/00_SESSION_BOOTSTRAP_PROMPT.md`.
4. Paste prompt **xx.0 (Context)** from `03_PROMPTS/PHASE_xx_*.md`.
5. Run prompts in order: **Inspect → Plan → Implement step 1 … step N → Review → Fix → Validate → Document → Gate**.
   - Do **not** paste the whole pack at once. One prompt, read the output, then the next.
   - After "Plan", **approve or edit the plan** before allowing implementation.
6. After each implementation prompt: read the diff, run the tests yourself, commit small.
7. Fill in the phase gate with **real** command output. PASS / CONDITIONAL / FAIL.
8. Open a PR using `06_TEMPLATES/PULL_REQUEST_TEMPLATE.md`. Require one human review (two for
   security-sensitive phases: 04, 07, 08, 09, 12, 14, 16).

## 3. Rules for talking to the agent

| Do | Don't |
|---|---|
| "Add a Zod schema for `RegisterTargetRequest` and reject ports outside policy" | "Make it production ready" |
| "Run `npm run test -w @qe/broker` and paste the actual output" | Accept "tests should pass" |
| "Stop after the inspection report" | Let it edit before you approved a plan |
| Ask for findings first in reviews | Let it silently "fix" by deleting tests |
| Keep one phase per branch | Mix refactors with features |
| Say which files are in scope | Let it touch `infra/` during a UI phase |

Red flags that mean **stop and review**:

- a test was deleted, skipped or its assertion weakened;
- `any`, `@ts-ignore`, `eslint-disable` added without a justification comment;
- a security check got an "if dev mode" bypass that is not compile-time/config-guarded;
- secrets, tokens or keys appear in logs, fixtures or snapshots;
- `StrictHostKeyChecking=no`, `hostVerifier: () => true`, `rejectUnauthorized: false`;
- shell strings built with template literals from user input.

## 4. Where the prompts live

| File | Use |
|---|---|
| `03_PROMPTS/00_SESSION_BOOTSTRAP_PROMPT.md` | Start of **every** agent session |
| `03_PROMPTS/01_STANDARD_8_STEP_LOOP.md` | The generic Inspect/Plan/Implement/Review/Fix/Validate/Document/Gate prompts |
| `03_PROMPTS/PHASE_xx_*.md` | Phase-specific prompt pack (context + one prompt per build step) |
| `03_PROMPTS/90_UTILITY_PROMPTS.md` | Debugging, failing CI, flaky test, security review, upgrade Theia, incident analysis |

## 5. Working without an AI agent

Every phase guide is complete on its own: steps, file lists, code skeletons, commands and tests. A human
team can execute the phases directly; the prompts are an accelerator, not a dependency.

## 6. Recording evidence

Create `docs/phase-gates/PHASE_xx.md` in the product repo for every phase. Paste real outputs (test
summary, screenshots, curl transcripts). At release, `04_OPERATIONS/PRODUCTION_READINESS_CHECKLIST.md`
links to these files as evidence.
