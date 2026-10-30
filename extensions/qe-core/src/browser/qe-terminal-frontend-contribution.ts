import { injectable } from '@theia/core/shared/inversify';
import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';

/**
 * Theia's terminal contribution, without the terminal it starts in every fresh layout. Terminals outlive the page, so
 * each new browser, device or private window left one running — the IDE's 10 terminals filled up without the user
 * opening any (Phase 10 review). A terminal now starts when the user opens one.
 */
@injectable()
export class QeTerminalFrontendContribution extends TerminalFrontendContribution {
  override initializeLayout(): Promise<void> {
    return Promise.resolve();
  }
}
