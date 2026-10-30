import { pytestAdapter } from './pytest-adapter.js';
import type { Framework, RunnerAdapter } from './types.js';

export { pytestAdapter } from './pytest-adapter.js';
export {
  checkRunEnv,
  checkRunId,
  checkSelector,
  markerExpression,
  nodeId,
  NODE_ID_PATTERN,
  projectPath,
} from './selectors.js';
export {
  Frameworks,
  RunStates,
  type CaseStatus,
  type Framework,
  type RunCommand,
  type RunContext,
  type RunCounts,
  type RunnerAdapter,
  type RunResults,
  type RunState,
  type RunTarget,
  type TestCaseResult,
  type TestNode,
  type TestRunRequest,
  type TestSelector,
} from './types.js';

const ADAPTERS: Readonly<Record<Framework, RunnerAdapter>> = { pytest: pytestAdapter };

/** The adapter of an allowed framework (07_SECURITY T11: no other command can be built). */
export function adapterFor(framework: Framework): RunnerAdapter {
  return ADAPTERS[framework];
}
