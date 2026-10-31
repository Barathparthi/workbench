import type { FsOp } from '@qe/contracts';
import type { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

/**
 * The embedded broker (desktop and local web, PHASE_10 §10.1, ADR-008): SSH to the user's own hosts runs in the IDE
 * backend on their machine, never in the browser page (rule 1). The frontend reaches it over Theia's authenticated
 * RPC channel; terminal streams carry the same `qews.v1` frames as the hosted broker's WebSocket
 * (09_LOCAL_AND_WEB_PARITY §3.3), so one frontend terminal adapter serves both.
 */
export const EMBEDDED_BROKER_PATH = '/services/qe-embedded-broker';
export const EmbeddedBrokerService = Symbol('EmbeddedBrokerService');

/** A personal target as the frontend lists it (no key paths or other local detail). */
export interface PersonalTargetSummary {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** `ProxyJump` is set: listed, but connecting is refused until jump hosts arrive (Phase 19). */
  readonly viaJumpHost: boolean;
}

/** Results cross the RPC channel as data, so the API error code arrives intact. */
export type EmbeddedResult<T> =
  | { readonly ok: true; readonly value: T }
  /** `message`: a fixed text for the user, where the code alone does not say what to change. */
  | { readonly ok: false; readonly code: string; readonly message?: string };

/** A test run on a personal host: as for managed targets, data only (`StartRemoteTestRunRequest` without a workspace). */
export interface RemoteTestRequest {
  readonly framework: 'pytest';
  readonly selector:
    | { readonly kind: 'all' }
    | { readonly kind: 'file'; readonly path: string }
    | { readonly kind: 'node'; readonly id: string }
    | { readonly kind: 'marker'; readonly expr: string };
}

/** A host to add to `~/.qe-workspace/ssh_hosts` ("QE: Add SSH Host…"). */
export interface NewHostRequest {
  readonly alias: string;
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
}

export interface EmbeddedBrokerService extends RpcServer<EmbeddedBrokerClient> {
  /** Hosts from `~/.ssh/config` and `~/.qe-workspace/ssh_hosts`, and the entries that could not be used. */
  listTargets(): Promise<{ targets: PersonalTargetSummary[]; problems: string[] }>;
  /** Adds a host to `~/.qe-workspace/ssh_hosts` (never `~/.ssh/config`); `CONFLICT` if the name exists. */
  addHost(request: NewHostRequest): Promise<EmbeddedResult<PersonalTargetSummary>>;
  /**
   * Starts a terminal stream under an id the frontend chose (a UUID), so its listener exists before the first frame;
   * frames and the close arrive through the client.
   */
  openTerminal(
    streamId: string,
    targetId: string,
    size: { cols: number; rows: number },
  ): Promise<EmbeddedResult<string>>;
  /**
   * Runs tests on a personal host (PHASE_11 §11.4), in the user's home there: a framework and a selector, never a
   * command line. Streams like a terminal under `streamId` (output frames, a `run` result, the close); an interrupt
   * or `closeTerminal` cancels the run on the host. Returns the run's id.
   */
  runTests(streamId: string, targetId: string, request: RemoteTestRequest): Promise<EmbeddedResult<string>>;
  /** A `qews.v1` frame from the terminal: binary input, or a JSON control message (resize, signal). */
  send(streamId: string, frame: string | Uint8Array): Promise<void>;
  closeTerminal(streamId: string): Promise<void>;
  /** One remote file operation (05_API_CONTRACTS §2.4 semantics), inside the target's home directory. */
  fs(targetId: string, op: FsOp, request: unknown): Promise<EmbeddedResult<unknown>>;
}

/** What the backend calls on the frontend. */
export interface EmbeddedBrokerClient {
  /** A `qews.v1` frame for a stream: binary output, or a JSON control message (status, hostkey, error, exit). */
  onFrame(streamId: string, frame: string | Uint8Array): void;
  onClosed(streamId: string, code: number, reason: string): void;
  /** Asks the user for a key file's passphrase (shown with the target's name); undefined when they cancel. */
  askPassphrase(targetName: string, keyFile: string): Promise<string | undefined>;
  /**
   * A personal host whose key is not in `known_hosts` (PHASE_10 §10.4): trust it for this window, trust it and save
   * it to QE's own known_hosts, or cancel. Asked between connect attempts, never on the handshake's timer.
   */
  confirmHostKey(question: HostKeyQuestion): Promise<HostKeyAnswer>;
}

export interface HostKeyQuestion {
  readonly targetName: string;
  readonly host: string;
  readonly port: number;
  readonly algorithm: string;
  readonly fingerprintSha256: string;
}

export type HostKeyAnswer = 'once' | 'save' | 'cancel';
