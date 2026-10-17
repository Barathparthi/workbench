# Phase 11 — QE Test Runner and Reports

| | |
|---|---|
| **Goal** | Run tests from a QE panel (local runtime or remote target), stream output, parse results, link reports |
| **Duration** | 1.5–2 weeks |
| **Prerequisites** | Phases 06, 08 (remote exec) |
| **Prompt pack** | `03_PROMPTS/PHASE_11_PROMPTS.md` |

## Deliverables
- `RunnerAdapter` interface + `PytestAdapter` (first) + `MavenSurefireAdapter` (second).
- Theia backend runner service (in runtime / desktop backend) with structured argv execution.
- Remote runs via broker `exec` capability.
- Streaming JUnit XML parser; run records + artifacts in control plane.
- QE Test panel: tree, run/cancel, live output, results, failures with click-to-source, report links.
- Integration with Theia/VS Code Testing API if available in pinned version (optional).

## Step-by-step

### 11.1 Domain
```ts
export type RunState = 'QUEUED'|'RUNNING'|'PASSED'|'FAILED'|'ERROR'|'CANCELLED';
export interface TestRunRequest { framework: 'pytest'|'maven'; selector?: TestSelector; target?: { kind: 'local' } | { kind: 'remote'; targetId: string }; env?: Record<string,string> }
export type TestSelector = { kind: 'all' } | { kind: 'file'; path: string } | { kind: 'node'; id: string } | { kind: 'marker'; expr: string };
export interface RunnerAdapter {
  readonly framework: string;
  discover(root: string): Promise<TestNode[]>;
  buildCommand(req: TestRunRequest, outDir: string): { file: string; args: string[]; cwd: string };
  resultFiles(outDir: string): string[];          // e.g. junit.xml
}
```

### 11.2 Pytest adapter
- Command: `python -m pytest <selector> -o junit_family=xunit2 --junitxml=<outDir>/junit.xml -p no:cacheprovider` (+ `--html` if pytest-html present).
- Selector validation: file path confined to workspace root; node IDs match `^[\w./\-\[\]:,= ]+$`; marker expr length-limited and passed as one argv element (`-m`, expr). **No shell.**
- Discovery: `python -m pytest --collect-only -q` parsed (timeout 60 s).

### 11.3 Execution (local)
- `spawn(file, args, { cwd, env: allowlistedEnv, shell: false, detached: true })` → stream stdout/stderr to client via Theia RPC; cancel = SIGINT to process group, SIGKILL after 10 s.
- Max concurrent runs per workspace (e.g. 2); max output buffered (ring buffer 5 MB, full log file on disk).

### 11.4 Execution (remote)
- `POST /targets/{id}/test-runs` → control plane authz (`qe_test:execute` + `remote:execute`) → broker `exec(argv)`; argv quoted by a single fixed function (`shellQuote` per POSIX) since SSH exec takes a string — **test the quoting** with hostile inputs.
- Artifacts fetched via SFTP from `<remoteRoot>/.qe-runs/<runId>/`.

### 11.5 Results
- Streaming XML parser (`sax`/`saxes`) to handle large files; map to `{suites, cases[{id, name, file, line, status, durationMs, message, stack}]}`; cap stored failure text (e.g. 64 KB/case).
- Persist run summary (`test_runs`), store artifacts (object storage or workspace path) with sha256.

### 11.6 UI
- Panel: test tree (discovery), Run all / Run file / Run selected / Cancel, live console, results summary bar, failure list with click-to-source, artifacts list (HTML report opens in webview/new tab via signed URL).
- Run history per workspace.

## Tests
- Unit: argv builders (no injection: `;`, `$()`, backticks, newlines in selectors), shell quoting, JUnit parser fixtures (pytest, surefire, malformed, 50 MB).
- Integration: sample repo (`tests/fixtures/sample-pytest-repo`: 3 pass, 1 fail, 1 skip) local and on SSH target; cancel mid-run; exit codes.
- E2E: run from panel → results tree 3/1/1 → click failure → editor at line.

## Exit criteria
- [ ] **Milestone M3**: Desktop + Web → same project → QE run → results + report.
- [ ] Injection tests green; cancel works locally and remotely.
