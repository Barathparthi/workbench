import {
  QuickInputService,
  type QuickPickItemOrSeparator,
} from '@theia/core/lib/browser/quick-input/quick-input-service';
import { type CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { encodeInput, type ServerControl } from '@qe/contracts';
import { QeCommands } from '@qe/theia-qe-core/lib/browser/qe-commands';
import { QeEnvironmentService } from '@qe/theia-qe-core/lib/common/qe-environment';

import type { RemoteTarget, TerminalStream } from '../common/connection-client';
import { describeFailure } from '../common/remote-client';
import { remoteRootUri } from '../common/remote-files';
import { QeRemoteServices, RemoteTargetNames } from './qe-remote-files';

/**
 * "Connect to Remote System…" (Phase 08 §8.5, ADR-006 option B) and "Open Remote Folder…" (Phase 09 §9.4), for every
 * mode (Phase 10): managed targets through the control plane and hosted broker, personal targets from the user's SSH
 * configuration through the embedded broker in the IDE backend. The terminal is a Theia widget with no backend
 * process of its own, fed the `qews.v1` frames of either broker by the same adapter.
 */
@injectable()
export class QeRemoteContribution implements CommandContribution {
  @inject(TerminalService) protected readonly terminals!: TerminalService;
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(QeEnvironmentService) protected readonly environment!: QeEnvironmentService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(QeRemoteServices) protected readonly services!: QeRemoteServices;
  @inject(RemoteTargetNames) protected readonly targetNames!: RemoteTargetNames;

  @postConstruct()
  protected init(): void {
    // Encrypted key files of personal targets: asked only after the agent and plain keys were rejected.
    this.services.embedded.setPassphraseAsker((targetName, keyFile) =>
      this.quickInput.input({
        title: `Passphrase for ${keyFile}`,
        prompt: `The key file ${keyFile} for ${targetName} is encrypted. The passphrase is used for this connection only.`,
        password: true,
        ignoreFocusLost: true,
      }),
    );
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(QeCommands.CONNECT_TARGET, { execute: () => this.connect() });
    registry.registerCommand(QeCommands.OPEN_REMOTE_FOLDER, { execute: () => this.openFolder() });
  }

  protected async connect(): Promise<void> {
    const target = await this.pickTarget('Connect to a remote system');
    if (target !== undefined) await this.openTerminal(target);
  }

  /** Adds the target's remote folder to the workspace (once); the Explorer shows it as `[target]`. */
  protected async openFolder(): Promise<void> {
    const target = await this.pickTarget('Open the remote folder of a system');
    if (target === undefined) return;
    const root = new URI(remoteRootUri(target.id));
    // Fail here, with the reason, rather than with an empty folder in the Explorer.
    try {
      await this.services.provider.stat(root);
    } catch (error) {
      await this.messages.error(error instanceof Error ? error.message : describeFailure(error));
      return;
    }
    if (this.workspace.tryGetRoots().some((r) => r.resource.isEqual(root))) return;
    await this.workspace.addRoot(root);
  }

  /** The user's choice among the systems this mode offers, or undefined (cancelled, none, or not available here). */
  protected async pickTarget(placeholder: string): Promise<RemoteTarget | undefined> {
    const env = await this.environment.getEnvironment();
    if (env.mode === 'hosted' ? !env.features.managedTargets : !env.features.personalTargets) {
      await this.messages.info(
        'Remote systems are available when QE Workspace is connected to a control plane.',
      );
      return undefined;
    }
    let listing: { targets: RemoteTarget[]; problems: string[] };
    try {
      listing = await this.services.connections.listTargets();
    } catch (error) {
      await this.messages.error(describeFailure(error));
      return undefined;
    }
    const { targets, problems } = listing;
    this.targetNames.remember(targets);
    if (problems.length > 0) {
      void this.messages.warn(
        `Some hosts in your SSH configuration cannot be used: ${problems.slice(0, 3).join('; ')}` +
          (problems.length > 3 ? ` (and ${String(problems.length - 3)} more)` : ''),
      );
    }
    if (targets.length === 0) {
      await this.messages.info(
        env.mode === 'hosted'
          ? 'No remote systems are available to you. Ask a lab admin for access.'
          : 'No remote systems found. Add a Host entry to ~/.ssh/config to see it here.',
      );
      return undefined;
    }
    const items: QuickPickItemOrSeparator[] = [];
    for (const kind of ['managed', 'personal'] as const) {
      const group = targets.filter((t) => t.kind === kind);
      if (group.length === 0) continue;
      items.push({ type: 'separator', label: kind === 'managed' ? 'Managed systems' : 'Your SSH hosts' });
      for (const t of group)
        items.push({ label: t.name, description: t.description, detail: t.detail, id: t.id });
    }
    const picked = await this.quickInput.showQuickPick(items, { placeholder });
    return targets.find((t) => t.id === picked?.id);
  }

  protected async openTerminal(target: RemoteTarget): Promise<void> {
    const widget = await this.terminals.newTerminal({
      title: `ssh: ${target.name}`,
      isPseudoTerminal: true,
      useServerTitle: false,
      destroyTermOnClose: true,
    });
    // The widget is fitted while the session opens, so keep the latest size and send it once the stream exists.
    let size = widget.dimensions;
    let stream: TerminalStream | undefined;
    const subscriptions = [
      widget.onSizeChanged((d) => {
        size = d;
        stream?.send(JSON.stringify({ t: 'resize', cols: d.cols, rows: d.rows }));
      }),
      widget.onData((data) => {
        for (const frame of encodeInput(new TextEncoder().encode(data))) stream?.send(frame);
      }),
    ];
    widget.onDidDispose(() => {
      subscriptions.forEach((s) => {
        s.dispose();
      });
      stream?.close();
    });
    await widget.start();
    void this.terminals.open(widget, { mode: 'activate' });
    widget.writeLine(`Connecting to ${target.name}…`);

    const decoder = new TextDecoder();
    try {
      stream = await this.services.connections.openTerminal(target, size, {
        frame: (frame) => {
          if (typeof frame === 'string') {
            this.onControl(widget, JSON.parse(frame) as ServerControl);
            return;
          }
          if (frame[0] === 0x01) widget.write(decoder.decode(frame.subarray(1), { stream: true }));
        },
        closed: (code) => {
          if (code !== 1000) widget.writeLine(`\r\n[connection closed: ${closeReason(code)}]`);
        },
      });
      stream.send(JSON.stringify({ t: 'resize', cols: size.cols, rows: size.rows }));
    } catch (error) {
      widget.writeLine(`\r\n${describeFailure(error)}`);
    }
  }

  protected onControl(widget: { writeLine(text: string): void }, message: ServerControl): void {
    switch (message.t) {
      case 'hostkey':
        widget.writeLine(`Host key verified (${message.algorithm} ${message.fingerprintSha256}).`);
        return;
      case 'error':
        widget.writeLine(`\r\n${message.message}`);
        return;
      case 'exit':
        widget.writeLine('\r\n[remote session ended]');
        return;
      case 'status':
        return;
    }
  }
}

export function closeReason(code: number): string {
  switch (code) {
    case 4001:
      return 'not authorized';
    case 4003:
      return 'not allowed';
    case 4008:
      return 'protocol error';
    case 4010:
      return 'session expired';
    case 4011:
      return 'revoked by an administrator';
    case 4013:
      return 'server restarting — reconnect';
    default:
      return 'remote session ended';
  }
}
