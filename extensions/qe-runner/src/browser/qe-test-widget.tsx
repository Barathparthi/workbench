import { open, OpenerService } from '@theia/core/lib/browser/opener-service';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import type { TestCaseResult, TestNode, TestSelector } from '@qe/runner';

import { QeTestRuns } from './qe-test-runs';
import { describeSelector, failuresOf, sourcePathOf, summaryOf, type RunView } from './test-runs-model';

const muted: React.CSSProperties = { color: 'var(--theia-descriptionForeground)' };
const section: React.CSSProperties = { padding: '6px 8px', borderTop: '1px solid var(--theia-panel-border)' };
const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 0',
  cursor: 'pointer',
};
const STATE_ICON: Readonly<Record<string, string>> = {
  RUNNING: 'loading~spin',
  QUEUED: 'clock',
  PASSED: 'pass',
  FAILED: 'error',
  ERROR: 'warning',
  CANCELLED: 'circle-slash',
};

/**
 * The QE Tests panel (PHASE_11 §11.6): the project's tests, Run all / a file / one test, Cancel, the live output, the
 * result with its failures (a click opens the test at the failing line), the run's files, and earlier runs. What it
 * shows comes from `TestRunsModel`; running is the IDE backend's (`QeTestRuns`).
 */
@injectable()
export class QeTestWidget extends ReactWidget {
  static readonly ID = 'qe-tests';
  static readonly LABEL = 'QE Tests';

  @inject(QeTestRuns) protected readonly runs!: QeTestRuns;
  @inject(OpenerService) protected readonly openers!: OpenerService;

  protected readonly expanded = new Set<string>();

  @postConstruct()
  protected init(): void {
    this.id = QeTestWidget.ID;
    this.title.label = QeTestWidget.LABEL;
    this.title.caption = QeTestWidget.LABEL;
    this.title.iconClass = codicon('beaker');
    this.title.closable = true;
    this.addClass('qe-tests');
    this.node.tabIndex = 0;
    this.toDispose.push(
      this.runs.model.onDidChange(() => {
        this.update();
      }),
    );
    void this.runs.refreshTests();
    void this.runs.loadHistory();
    void this.runs.loadSystems();
    this.update();
  }

  /** Runs where "Run on" says: the project folder, or a remote system's folder. */
  protected run(selector: TestSelector): void {
    void this.runs.runSelected(selector);
  }

  protected render(): React.ReactNode {
    const model = this.runs.model;
    const selected = model.selected;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
        {this.renderToolbar(selected)}
        {this.renderTree()}
        {selected !== undefined && this.renderRun(selected)}
        {this.renderHistory()}
      </div>
    );
  }

  protected renderToolbar(selected: RunView | undefined): React.ReactNode {
    const running = selected?.state === 'RUNNING' ? selected : undefined;
    return (
      <div style={{ display: 'flex', gap: 4, padding: '6px 8px' }}>
        <button
          className="theia-button qe-tests-run-all"
          onClick={() => {
            this.run({ kind: 'all' });
          }}
        >
          <i className={codicon('run-all')} /> Run all
        </button>
        {running !== undefined && (
          <button
            className="theia-button secondary qe-tests-cancel"
            onClick={() => void this.runs.cancel(running.runId)}
          >
            <i className={codicon('debug-stop')} /> Cancel
          </button>
        )}
        <button
          className="theia-button secondary qe-tests-refresh"
          title="List the tests and remote systems again"
          onClick={() => {
            void this.runs.refreshTests();
            void this.runs.loadSystems();
          }}
        >
          <i className={codicon('refresh')} />
        </button>
        {this.runs.systems.length > 0 && (
          <select
            className="theia-select qe-tests-run-on"
            title="Where the tests run"
            value={this.runs.runOn ?? ''}
            onChange={(e) => {
              this.runs.setRunOn(e.target.value === '' ? undefined : e.target.value);
            }}
          >
            <option value="">This project</option>
            {this.runs.systems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.description}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }

  protected renderTree(): React.ReactNode {
    const model = this.runs.model;
    return (
      <div style={section} className="qe-tests-tree">
        {model.discovering && <div style={muted}>Listing tests…</div>}
        {model.discoveryProblem !== undefined && (
          <pre style={{ ...muted, whiteSpace: 'pre-wrap', margin: 0 }} className="qe-tests-tree-problem">
            {model.discoveryProblem}
          </pre>
        )}
        {model.tree.map((file) => this.renderFile(file))}
      </div>
    );
  }

  protected renderFile(file: TestNode): React.ReactNode {
    const open = this.expanded.has(file.id);
    return (
      <div key={file.id}>
        <div style={row} className="qe-tests-tree-node" data-node-id={file.id}>
          <i
            className={codicon(open ? 'chevron-down' : 'chevron-right')}
            onClick={() => {
              if (open) this.expanded.delete(file.id);
              else this.expanded.add(file.id);
              this.update();
            }}
          />
          <span style={{ flex: 1 }}>{file.label}</span>
          <i
            className={`${codicon('play')} qe-tests-run-node`}
            title={`Run ${file.label}`}
            onClick={() => {
              this.run({ kind: 'file', path: file.file });
            }}
          />
        </div>
        {open &&
          file.children.map((test) => (
            <div
              key={test.id}
              style={{ ...row, paddingLeft: 22 }}
              className="qe-tests-tree-node"
              data-node-id={test.id}
            >
              <span style={{ flex: 1 }}>{test.label}</span>
              <i
                className={`${codicon('play')} qe-tests-run-node`}
                title={`Run ${test.label}`}
                onClick={() => {
                  this.run({ kind: 'node', id: test.id });
                }}
              />
            </div>
          ))}
      </div>
    );
  }

  protected renderRun(run: RunView): React.ReactNode {
    const failures = failuresOf(run.outcome);
    return (
      <div style={section} className="qe-tests-run" data-run-id={run.runId} data-state={run.state}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <i className={codicon(STATE_ICON[run.state] ?? 'circle')} />
          <strong>{describeSelector(run.selector)}</strong>
          <span style={muted}>{run.where}</span>
        </div>
        <div className="qe-tests-summary" style={{ margin: '4px 0' }}>
          {run.state === 'RUNNING' ? 'Running…' : summaryOf(run.outcome)}
        </div>
        {run.problem !== undefined && <div className="qe-tests-problem">{run.problem}</div>}
        {failures.map((f) => this.renderFailure(f, run))}
        {run.outcome !== undefined && run.outcome.artifacts.length > 0 && (
          <div style={{ margin: '4px 0' }}>
            {run.outcome.artifacts.map((a) => (
              <a
                key={a.path}
                className="qe-tests-artifact"
                style={{ marginRight: 10, cursor: 'pointer' }}
                onClick={() => {
                  this.openRunFile(a.path, run);
                }}
              >
                {a.kind === 'junit_xml'
                  ? 'JUnit report'
                  : a.kind === 'html_report'
                    ? 'HTML report'
                    : 'Output log'}
              </a>
            ))}
          </div>
        )}
        <pre
          className="qe-tests-output"
          style={{
            maxHeight: 240,
            overflow: 'auto',
            margin: 0,
            padding: 6,
            fontFamily: 'var(--theia-code-font-family)',
            fontSize: 'var(--theia-code-font-size)',
            background: 'var(--theia-editor-background)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {run.output}
        </pre>
      </div>
    );
  }

  protected renderFailure(failure: TestCaseResult, run: RunView): React.ReactNode {
    const where =
      failure.file === undefined
        ? ''
        : `${failure.file}${failure.line === undefined ? '' : `:${String(failure.line)}`}`;
    return (
      <div
        key={failure.id}
        className="qe-tests-failure"
        style={{ ...row, alignItems: 'flex-start' }}
        title={where === '' ? failure.name : `Open ${where}`}
        onClick={() => {
          this.openFailure(failure, run);
        }}
      >
        <i className={codicon(failure.status === 'error' ? 'warning' : 'error')} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div>{failure.name}</div>
          <div style={{ ...muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {where} {failure.message?.split('\n')[0] ?? ''}
          </div>
        </div>
      </div>
    );
  }

  protected renderHistory(): React.ReactNode {
    const history = this.runs.model.history;
    if (history.length === 0) return undefined;
    return (
      <div style={section} className="qe-tests-history">
        <div style={muted}>Earlier runs</div>
        {history.map((record) => (
          <div
            key={record.run.runId}
            style={row}
            className="qe-tests-history-run"
            onClick={() => {
              this.runs.model.showRecord(record);
            }}
          >
            <i className={codicon(STATE_ICON[record.outcome.state] ?? 'circle')} />
            <span style={{ flex: 1 }}>{describeSelector(record.run.selector)}</span>
            <span style={muted}>{new Date(record.run.startedAt).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    );
  }

  /** A file of the project, by its path relative to the project folder (absolute paths inside it work too). */
  protected projectUri(path: string): URI | undefined {
    const root = this.runs.projectRoot();
    if (root === undefined) return undefined;
    if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
      const uri = URI.fromFilePath(path);
      return root.isEqualOrParent(uri) ? uri : undefined;
    }
    return root.resolve(path);
  }

  /**
   * A file of where the run happened: the project folder, or — for a remote run — the system's folder, through the
   * remote folder's provider (`qe-ssh://`), where the files really are.
   */
  protected runFileUri(path: string, run: RunView): URI | undefined {
    if (run.systemId === undefined) return this.projectUri(path);
    if (path.startsWith('/') || path.includes('..')) return undefined;
    const remote = this.runs.remoteFileUri(run.systemId, path);
    return remote === undefined ? undefined : new URI(remote);
  }

  protected openRunFile(path: string, run: RunView): void {
    const uri = this.runFileUri(path, run);
    if (uri !== undefined) void open(this.openers, uri);
  }

  protected openFailure(failure: TestCaseResult, run: RunView): void {
    const path = sourcePathOf(failure);
    if (path === undefined) return;
    const uri = this.runFileUri(path, run);
    if (uri === undefined) return;
    const line = Math.max(0, (failure.line ?? 1) - 1);
    void open(this.openers, uri, {
      selection: { start: { line, character: 0 }, end: { line, character: 0 } },
    });
  }
}
