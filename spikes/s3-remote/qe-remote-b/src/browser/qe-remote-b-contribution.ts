import { open, OpenerService } from '@theia/core/lib/browser';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileService, FileServiceContribution } from '@theia/filesystem/lib/browser/file-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';

import { openSession, openStream, TARGET_ID } from './broker-client';
import { REMOTE_SCHEME_B, RemoteFileSystemProvider } from './remote-file-system-provider';

export const OpenRemoteTerminalB: Command = { id: 'qe.remoteB.openTerminal', label: 'QE Remote (B): Open Terminal' };
export const OpenRemoteFileB: Command = { id: 'qe.remoteB.openFile', label: 'QE Remote (B): Open hello.txt' };

/**
 * Registered separately and dependency-free: FileService collects FileServiceContributions while it is being
 * constructed, so a contribution that injects TerminalService (which needs FileService) creates a DI cycle
 * and the frontend fails to start.
 */
@injectable()
export class QeRemoteBFileSystemContribution implements FileServiceContribution {
  registerFileSystemProviders(service: FileService): void {
    service.registerProvider(REMOTE_SCHEME_B, new RemoteFileSystemProvider());
  }
}

@injectable()
export class QeRemoteBContribution implements CommandContribution {
  @inject(TerminalService) protected readonly terminals!: TerminalService;
  @inject(OpenerService) protected readonly openerService!: OpenerService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(OpenRemoteTerminalB, { execute: () => this.openTerminal() });
    registry.registerCommand(OpenRemoteFileB, {
      execute: () => open(this.openerService, new URI(`${REMOTE_SCHEME_B}://${TARGET_ID}/hello.txt`)),
    });
  }

  /** A Theia terminal widget with no backend process: its I/O is wired to the broker stream. */
  protected async openTerminal(): Promise<void> {
    const widget = await this.terminals.newTerminal({
      title: `qe-ssh ${TARGET_ID} (B)`,
      isPseudoTerminal: true,
      useServerTitle: false,
      destroyTermOnClose: true,
    });
    // Track the size from the start: the widget is fitted (and fires onSizeChanged) while the session is
    // still being opened, so the real size must be sent explicitly once the stream exists.
    let size = widget.dimensions;
    let stream: ReturnType<typeof openStream> | undefined;
    const sizeSub = widget.onSizeChanged((d) => {
      size = d;
      stream?.resize(d.cols, d.rows);
    });
    await widget.start();
    this.terminals.open(widget, { mode: 'activate' });
    const session = await openSession('terminal', { cols: size.cols, rows: size.rows });
    stream = openStream(session, {
      onOutput: (text) => widget.write(text),
      onControl: (msg) => {
        if (msg.t === 'exit') widget.writeLine('\r\n[remote session closed]');
      },
    });
    stream.resize(size.cols, size.rows);
    const subscriptions = [sizeSub, widget.onData((data) => stream?.input(data))];
    widget.onDidDispose(() => {
      subscriptions.forEach((s) => s.dispose());
      stream?.close();
    });
  }
}
