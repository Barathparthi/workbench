import type { LabelProviderContribution, DidChangeLabelEvent } from '@theia/core/lib/browser/label-provider';
import { Emitter } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { FileService, FileServiceContribution } from '@theia/filesystem/lib/browser/file-service';
import { FileStat } from '@theia/filesystem/lib/common/files';

import { remoteClient, type TargetSummary } from '../common/remote-client';
import { QE_SSH_SCHEME, RemoteFileSessions, type SessionStore } from '../common/remote-files';
import { QeSshFileSystemProvider } from './qe-ssh-file-system-provider';

/**
 * The page's remote API client, files-sessions and `qe-ssh` provider. Deliberately free of injected dependencies:
 * FileService collects FileServiceContributions while it is being constructed, so anything they inject must not need
 * FileService (spike S3: a cycle there stops the frontend).
 */
@injectable()
export class QeRemoteServices {
  readonly client = remoteClient({
    origin: window.location.origin,
    cookies: () => document.cookie,
    fetch: (input, init) => fetch(input, init),
  });
  readonly provider = new QeSshFileSystemProvider(
    new RemoteFileSessions(this.client, tabSessionStore()),
    userIsActive(),
  );
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

  remember(targets: readonly TargetSummary[]): void {
    for (const t of targets) this.names.set(t.id, t.name);
    this.changed.fire();
  }

  /** The target's name, or undefined until the list has loaded (a change event follows). */
  get(targetId: string): string | undefined {
    const name = this.names.get(targetId);
    if (name === undefined) {
      this.loading ??= this.services.client
        .listTargets()
        .then((targets) => {
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
