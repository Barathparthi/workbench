import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { environment, isOSX } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { GettingStartedWidget } from '@theia/getting-started/lib/browser/getting-started-widget';

import { QE_DOCUMENTATION_URL_PREFERENCE } from '../common/qe-preferences';
import { QE_QUICK_LINKS, safeDocumentationUrl, type QeQuickLink } from './qe-quick-links';

/** Theia's welcome page with QE quick links in place of the Theia/AI sections. */
@injectable()
export class QeWelcomeWidget extends GettingStartedWidget {
  protected override render(): React.ReactNode {
    return (
      <div className="gs-container qe-welcome">
        <div className="gs-content-container">
          {this.renderHeader()}
          <hr className="gs-hr" />
          <div className="flex-grid">
            <div className="col">{this.renderQuickLinks()}</div>
          </div>
          <div className="flex-grid">
            <div className="col">{this.renderRecentWorkspaces()}</div>
          </div>
          <div className="flex-grid">
            <div className="col">{this.renderVersion()}</div>
          </div>
        </div>
      </div>
    );
  }

  protected override renderHeader(): React.ReactNode {
    return (
      <div className="gs-header">
        <h1>
          {this.applicationName}
          <span className="gs-sub-header"> Welcome</span>
        </h1>
      </div>
    );
  }

  protected renderQuickLinks(): React.ReactNode {
    return (
      <div className="gs-section">
        <h3 className="gs-section-header">
          <i className={codicon('rocket')}></i>
          Get started
        </h3>
        {QE_QUICK_LINKS.map((link) => (
          <div className="gs-action-container" key={link.label}>
            <a
              role="button"
              tabIndex={0}
              onClick={() => void this.openQuickLink(link)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void this.openQuickLink(link);
              }}
            >
              {link.label}
            </a>
          </div>
        ))}
      </div>
    );
  }

  protected async openQuickLink(link: QeQuickLink): Promise<void> {
    switch (link.kind) {
      case 'open-project':
        // Same choice as Theia's "Start" section: one Open dialog in browsers and on macOS.
        await (isOSX || !environment.electron.is() ? this.doOpen() : this.doOpenFolder());
        return;
      case 'command':
        await this.commandRegistry.executeCommand(link.commandId);
        return;
      case 'docs': {
        const url = safeDocumentationUrl(this.preferenceService.get(QE_DOCUMENTATION_URL_PREFERENCE));
        if (url !== undefined) this.windowService.openNewWindow(url, { external: true });
        return;
      }
    }
  }
}
