import { QuickInputService } from '@theia/core/lib/browser/quick-input/quick-input-service';
import { type CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { encodeInput, type ServerControl } from '@qe/contracts';
import { QeCommands } from '@qe/theia-qe-core/lib/browser/qe-commands';
import { QeEnvironmentService } from '@qe/theia-qe-core/lib/common/qe-environment';

import { describeFailure, remoteClient, streamTarget, type TargetSummary } from '../common/remote-client';

/**
 * "Connect to Remote System…" (Phase 08 §8.5, ADR-006 option B): pick a registered target, open a session, and
 * render the broker's `qews.v1` stream in a Theia terminal widget with no backend process. Everything goes from this
 * page to the control plane and broker — never through the workspace runtime (P9).
 */
@injectable()
export class QeRemoteContribution implements CommandContribution {
  @inject(TerminalService) protected readonly terminals!: TerminalService;
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(QeEnvironmentService) protected readonly environment!: QeEnvironmentService;

  protected readonly client = remoteClient({
    origin: window.location.origin,
    cookies: () => document.cookie,
    fetch: (input, init) => fetch(input, init),
  });

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(QeCommands.CONNECT_TARGET, { execute: () => this.connect() });
  }

  protected async connect(): Promise<void> {
    const env = await this.environment.getEnvironment();
    if (!env.features.managedTargets) {
      await this.messages.info(
        'Remote systems are available when QE Workspace is connected to a control plane.',
      );
      return;
    }
    let targets: TargetSummary[];
    try {
      targets = await this.client.listTargets();
    } catch (error) {
      await this.messages.error(describeFailure(error));
      return;
    }
    if (targets.length === 0) {
      await this.messages.info('No remote systems are available to you. Ask a lab admin for access.');
      return;
    }
    const picked = await this.quickInput.showQuickPick(
      targets.map((t) => ({
        label: t.name,
        description: t.host,
        detail: [t.os, ...t.tags].join(' · ') + (t.description === null ? '' : ` — ${t.description}`),
        target: t,
      })),
      { placeholder: 'Connect to a remote system' },
    );
    if (picked === undefined) return;
    await this.openTerminal(picked.target);
  }

  protected async openTerminal(target: TargetSummary): Promise<void> {
    const widget = await this.terminals.newTerminal({
      title: `ssh: ${target.name}`,
      isPseudoTerminal: true,
      useServerTitle: false,
      destroyTermOnClose: true,
    });
    // The widget is fitted while the session opens, so keep the latest size and send it once the stream exists.
    let size = widget.dimensions;
    let socket: WebSocket | undefined;
    const send = (frame: string | Uint8Array) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
    };
    const subscriptions = [
      widget.onSizeChanged((d) => {
        size = d;
        send(JSON.stringify({ t: 'resize', cols: d.cols, rows: d.rows }));
      }),
      widget.onData((data) => {
        for (const frame of encodeInput(new TextEncoder().encode(data))) send(frame);
      }),
    ];
    widget.onDidDispose(() => {
      subscriptions.forEach((s) => {
        s.dispose();
      });
      socket?.close(1000);
    });
    await widget.start();
    void this.terminals.open(widget, { mode: 'activate' });
    widget.writeLine(`Connecting to ${target.name}…`);

    try {
      const session = await this.client.openTerminalSession(target.id, size);
      const { url, protocols } = streamTarget(window.location.origin, session);
      socket = new WebSocket(url, protocols);
      socket.binaryType = 'arraybuffer';
      const decoder = new TextDecoder();
      socket.onopen = () => {
        send(JSON.stringify({ t: 'resize', cols: size.cols, rows: size.rows }));
      };
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        if (typeof event.data === 'string') {
          this.onControl(widget, JSON.parse(event.data) as ServerControl);
          return;
        }
        const bytes = new Uint8Array(event.data);
        if (bytes[0] === 0x01) widget.write(decoder.decode(bytes.subarray(1), { stream: true }));
      };
      socket.onclose = (event) => {
        if (event.code !== 1000) widget.writeLine(`\r\n[connection closed: ${closeReason(event.code)}]`);
      };
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
