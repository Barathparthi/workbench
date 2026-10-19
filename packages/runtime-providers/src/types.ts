/** Resource profile names (contracts ResourceProfiles) and what each grants a runtime. */
export const RuntimeProfiles = {
  small: { cpu: '1', memory: '2Gi', pids: 512, disk: '10Gi' },
  standard: { cpu: '2', memory: '4Gi', pids: 1024, disk: '20Gi' },
  large: { cpu: '4', memory: '8Gi', pids: 2048, disk: '40Gi' },
} as const;
export type RuntimeProfile = keyof typeof RuntimeProfiles;
export type RuntimeResources = (typeof RuntimeProfiles)[RuntimeProfile];

/** Everything a provider needs to run one workspace (Phase 05 §5.1). Never contains secrets. */
export interface RuntimeSpec {
  readonly workspaceId: string;
  /** Image reference, pinned by digest in templates. */
  readonly image: string;
  readonly profile: RuntimeProfile;
  /** Non-secret environment for the Theia backend (QE_MODE, QE_WORKSPACE_ID, QE_CONTROL_PLANE_URL). */
  readonly env: Readonly<Record<string, string>>;
  /** Cloned into the project volume on the first start only (https, no credentials — validated upstream). */
  readonly git?: { readonly url: string; readonly ref: string } | undefined;
}

/**
 * What a provider observes. `running` only means the container/pod runs; the lifecycle service probes
 * `endpoint` before it calls a workspace RUNNING.
 */
export type RuntimeStatus =
  | { readonly phase: 'absent' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'running'; readonly endpoint: string }
  | { readonly phase: 'stopped' }
  | { readonly phase: 'failed'; readonly reason: string };

export interface WorkspaceRuntimeProvider {
  readonly kind: 'docker' | 'kubernetes';
  /** Creates what is missing and starts it. Safe to call again at any time (idempotent). */
  ensureStarted(spec: RuntimeSpec): Promise<RuntimeStatus>;
  /** Stops and removes the container/pod; keeps the project volume. Idempotent. */
  ensureStopped(workspaceId: string): Promise<void>;
  status(workspaceId: string): Promise<RuntimeStatus>;
  /** Removes everything, including the project volume. Idempotent. */
  destroy(workspaceId: string): Promise<void>;
  /** Workspace ids that currently have a container/pod (for the reconciler). */
  listRuntimes(): Promise<string[]>;
}

/** Workspace ids are UUIDs; anything else must never reach a resource name or label. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertWorkspaceId(id: string): string {
  if (!UUID.test(id)) throw new Error('invalid workspace id');
  return id;
}

/** Resource names derived from the workspace id (DNS-1123 safe). */
export const runtimeNames = (workspaceId: string) => {
  const id = assertWorkspaceId(workspaceId);
  return {
    container: `qews-ws-${id}`,
    volume: `qews-ws-${id}`,
    service: `qews-ws-${id}`,
    pvc: `qews-ws-${id}`,
  };
};

export const WORKSPACE_LABEL = 'qews.workspace-id';
export const PROJECT_DIR = '/home/qe/project';
export const IDE_PORT = 3000;
export const RUNTIME_UID = 1000;

/**
 * First-start clone, run as a separate step with the same image. The URL and ref are passed as
 * positional arguments ($1, $2), never interpolated into the script (no shell injection), and the clone
 * only happens into an empty project directory, so restarts never touch user files.
 */
export const CLONE_SCRIPT =
  'set -eu; if [ -z "$(ls -A "$3" 2>/dev/null)" ]; then exec git clone --depth 1 --branch "$2" -- "$1" "$3"; fi';

export const cloneCommand = (git: { url: string; ref: string }): string[] => [
  '/bin/sh',
  '-c',
  CLONE_SCRIPT,
  'qews-clone',
  git.url,
  git.ref,
  PROJECT_DIR,
];

/** Converts Kubernetes-style quantities to Docker's numbers. */
export function toBytes(quantity: string): number {
  const m = /^(\d+)(Ki|Mi|Gi|Ti)?$/.exec(quantity);
  if (m === null) throw new Error(`bad quantity ${quantity}`);
  const unit = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 }[m[2] ?? ''] ?? 1;
  return Number(m[1]) * unit;
}

export const toNanoCpus = (cpu: string): number => Math.round(Number(cpu) * 1e9);
