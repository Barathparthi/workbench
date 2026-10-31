import type { LabelProviderContribution, DidChangeLabelEvent } from '@theia/core/lib/browser/label-provider';
import { Emitter } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import type { FileService, FileServiceContribution } from '@theia/filesystem/lib/browser/file-service';
import { FileStat } from '@theia/filesystem/lib/common/files';

import { QeEnvironmentService } from '@qe/theia-qe-core/lib/common/qe-environment';

import {
  compositeConnectionClient,
  EmbeddedConnection,
  hostedConnectionClient,
  RelayedConnection,
  type ConnectionClient,
  type RemoteTarget,
} from '../common/connection-client';
import type { EmbeddedBrokerClient, EmbeddedBrokerService } from '../common/embedded-broker-protocol';
import type { ManagedRelayService, StreamClient } from '../common/managed-relay-protocol';
import { remoteClient } from '../common/remote-client';
import { QE_SSH_SCHEME, RemoteFileSessions, type SessionStore } from '../common/remote-files';
import { QeSshFileSystemProvider } from './qe-ssh-file-system-provider';
import { DEFAULT_WATCHER_OPTIONS } from './remote-watcher';

/** Creates the RPC proxy to the backend's embedded broker, with the given client for its callbacks. */
export const EmbeddedBrokerConnector = Symbol('EmbeddedBrokerConnector');
export type EmbeddedBrokerConnector = (client: EmbeddedBrokerClient) => EmbeddedBrokerService;

/** Desktop only: creates the RPC proxy to the backend's managed-target relay (PHASE_10 §10.4). */
export const ManagedRelayConnector = Symbol('ManagedRelayConnector');
export type ManagedRelayConnector = (client: StreamClient) => ManagedRelayService;

/**
 * The page's connection client, files-sessions and `qe-ssh` provider. Its dependencies must not need FileService:
 * FileService collects FileServiceContributions while it is being constructed (spike S3: a cycle there stops the
 * frontend) — the environment and the embedded broker are RPC proxies, which do not.
 *
 * Which parts exist follows the mode: hosted reaches managed targets through the control plane on its own origin;
 * local web and desktop reach personal targets through the embedded broker; the desktop app reaches managed targets
 * through its backend's relay, signed in to its control plane (PHASE_10 §10.4). Proxies are created on first use
 * only, so a hosted page never opens the embedded broker's.
 */
@injectable()
export class QeRemoteServices {
  @inject(QeEnvironmentService) protected readonly environment!: QeEnvironmentService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(EmbeddedBrokerConnector) protected readonly connectEmbedded!: EmbeddedBrokerConnector;
  @inject(ManagedRelayConnector) @optional() protected readonly connectRelay:
    ManagedRelayConnector | undefined;

  readonly client = remoteClient({
    origin: window.location.origin,
    cookies: () => document.cookie,
    fetch: (input, init) => fetch(input, init),
  });
  protected embeddedService: EmbeddedBrokerService | undefined;
  readonly embedded = new EmbeddedConnection(() => {
    this.embeddedService ??= this.connectEmbedded(this.embedded.client);
    return this.embeddedService;
  });
  protected relayService: ManagedRelayService | undefined;
  readonly relayed = new RelayedConnection(() => {
    if (this.connectRelay === undefined) throw new Error('no managed relay in this app');
    this.relayService ??= this.connectRelay(this.relayed.client);
    return this.relayService;
  });
  protected parts: Promise<ConnectionClient> | undefined;

  /** Managed and personal targets as this mode offers them, resolved on first use (after injection). */
  readonly connections: ConnectionClient = {
    listTargets: async () => (await this.resolve()).listTargets(),
    openTerminal: async (target, size, sink) => (await this.resolve()).openTerminal(target, size, sink),
    runTests: async (target, request, sink) => (await this.resolve()).runTests(target, request, sink),
    call: async (targetId, op, body) => (await this.resolve()).call(targetId, op, body),
  };

  readonly provider = new QeSshFileSystemProvider(
    this.connections,
    userIsActive(),
    DEFAULT_WATCHER_OPTIONS,
    (message) => void this.messages.warn(message),
  );

  protected resolve(): Promise<ConnectionClient> {
    this.parts ??= this.environment.getEnvironment().then((env) =>
      compositeConnectionClient({
        managed:
          env.mode === 'hosted'
            ? hostedConnectionClient({
                client: this.client,
                files: new RemoteFileSessions(this.client, tabSessionStore()),
                origin: window.location.origin,
                createSocket: (url, protocols) => new WebSocket(url, protocols),
                // Test runs belong to this workspace: its members see them.
                ...(env.workspaceId !== undefined && { workspaceId: env.workspaceId }),
              })
            : env.mode === 'desktop' && env.features.managedTargets && this.connectRelay !== undefined
              ? this.relayed
              : undefined,
        personal: env.features.personalTargets ? this.embedded : undefined,
      }),
    );
    return this.parts;
  }
}

/** Per tab, kept across reloads; best effort (storage may be unavailable, e.g. in a private window). */
function tabSessionStore(): SessionStore {
  const key = (targetId: string) => `qe.remote.filesSession.${targetId}`;
  return {
    get: (targetId) => {
      try {
        return sessionStorage.getItem(key(targetId)) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set: (targetId, sessionId) => {
      try {
        sessionStorage.setItem(key(targetId), sessionId);
      } catch {
        // not remembered: a reload opens a new session
      }
    },
    delete: (targetId) => {
      try {
        sessionStorage.removeItem(key(targetId));
      } catch {
        // nothing to forget
      }
    },
  };
}

/** After this long without input the user counts as away: remote polling pauses (PHASE_09 §9.5 idle back-off). */
const AWAY_AFTER_MS = 10 * 60_000;

/** True while the page is visible and the user typed, clicked or scrolled within AWAY_AFTER_MS. */
function userIsActive(): () => boolean {
  let lastInput = Date.now();
  const seen = () => {
    lastInput = Date.now();
  };
  for (const event of ['keydown', 'mousedown', 'wheel', 'touchstart']) {
    window.addEventListener(event, seen, { capture: true, passive: true });
  }
  return () => document.visibilityState === 'visible' && Date.now() - lastInput < AWAY_AFTER_MS;
}

@injectable()
export class QeSshFileSystemContribution implements FileServiceContribution {
  @inject(QeRemoteServices) protected readonly services!: QeRemoteServices;

  registerFileSystemProviders(service: FileService): void {
    service.registerProvider(QE_SSH_SCHEME, this.services.provider);
  }
}

/** Target names for labels, from the target list (loaded once, refreshed when the user picks a target). */
@injectable()
export class RemoteTargetNames {
  @inject(QeRemoteServices) protected readonly services!: QeRemoteServices;
  protected readonly names = new Map<string, string>();
  protected readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  protected loading: Promise<void> | undefined;

  remember(targets: readonly RemoteTarget[]): void {
    // URIs lowercase their authority, so names are kept by lowercase id.
    for (const t of targets) this.names.set(t.id.toLowerCase(), t.name);
    this.changed.fire();
  }

  /** The target's name, or undefined until the list has loaded (a change event follows). */
  get(targetId: string): string | undefined {
    const name = this.names.get(targetId.toLowerCase());
    if (name === undefined) {
      this.loading ??= this.services.connections
        .listTargets()
        .then(({ targets }) => {
          this.remember(targets);
        })
        .catch(() => {
          this.loading = undefined;
        });
    }
    return name;
  }
}

const remoteUri = (element: object): URI | undefined => {
  const uri = element instanceof URI ? element : FileStat.is(element) ? element.resource : undefined;
  return uri?.scheme === QE_SSH_SCHEME ? uri : undefined;
};
const isRoot = (uri: URI) => uri.path.toString() === '/' || uri.path.toString() === '';

/**
 * Remote folders are labelled with their system (PHASE_09 §9.4): the root reads `[lab-a-dev]` with a remote icon,
 * and every remote file's long name (tabs, tooltips) says which system it lives on. Everything else falls through to
 * Theia's own labels.
 */
@injectable()
export class QeSshLabelProviderContribution implements LabelProviderContribution {
  @inject(RemoteTargetNames) protected readonly names!: RemoteTargetNames;
  protected readonly changed = new Emitter<DidChangeLabelEvent>();
  readonly onDidChange = this.changed.event;
  protected subscribed = false;

  canHandle(element: object): number {
    if (remoteUri(element) === undefined) return 0;
    if (!this.subscribed) {
      this.subscribed = true;
      this.names.onDidChange(() => {
        this.changed.fire({ affects: (e) => remoteUri(e) !== undefined });
      });
    }
    return 100;
  }

  protected system(uri: URI): string {
    return `[${this.names.get(uri.authority) ?? 'remote'}]`;
  }

  getName(element: object): string | undefined {
    const uri = remoteUri(element);
    return uri !== undefined && isRoot(uri) ? this.system(uri) : undefined;
  }

  getLongName(element: object): string | undefined {
    const uri = remoteUri(element);
    return uri === undefined ? undefined : `${this.system(uri)} ${uri.path.toString()}`;
  }

  getIcon(element: object): string | undefined {
    const uri = remoteUri(element);
    return uri !== undefined && isRoot(uri) ? 'codicon codicon-remote' : undefined;
  }
}
