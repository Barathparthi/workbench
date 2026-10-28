import { AbstractDialog } from '@theia/core/lib/browser/dialogs';

import type { HostKeyAnswer, HostKeyQuestion } from '../common/embedded-broker-protocol';

/**
 * "Unknown host key" for a personal target (PHASE_10 §10.4): the host, the key's algorithm and its SHA256 fingerprint,
 * as `ssh` shows them, with three explicit choices. Closing the dialog, Escape and Enter all mean Cancel — nothing is
 * trusted without a click on a trust button.
 */
export class HostKeyDialog extends AbstractDialog<HostKeyAnswer> {
  protected answer: HostKeyAnswer = 'cancel';

  constructor(question: HostKeyQuestion) {
    super({ title: `Unknown host key for ${question.targetName}` });
    const where = question.port === 22 ? question.host : `[${question.host}]:${String(question.port)}`;
    const text = document.createElement('div');
    text.style.maxWidth = '42em';
    const intro = document.createElement('p');
    intro.textContent = `The authenticity of host ${where} can't be established. Its ${question.algorithm} key fingerprint is:`;
    const fingerprint = document.createElement('p');
    fingerprint.textContent = question.fingerprintSha256;
    fingerprint.style.fontFamily = 'var(--theia-code-font-family)';
    fingerprint.style.userSelect = 'all';
    const advice = document.createElement('p');
    advice.textContent =
      'Compare it with the fingerprint your administrator or the host itself (ssh-keygen -lf) gives you. ' +
      '"Trust and save" adds it to ~/.qe-workspace/known_hosts.';
    text.append(intro, fingerprint, advice);
    this.contentNode.appendChild(text);
    this.closeButton = this.button('Cancel', false, 'cancel');
    this.button('Trust once', false, 'once');
    this.button('Trust and save', true, 'save');
  }

  get value(): HostKeyAnswer {
    return this.answer;
  }

  protected button(label: string, primary: boolean, answer: HostKeyAnswer): HTMLButtonElement {
    const button = this.appendButton(label, primary);
    button.addEventListener('click', () => {
      this.answer = answer;
      void this.accept();
    });
    return button;
  }

  /** Enter must not trust a key: it cancels like Escape does. */
  protected override handleEnter(): boolean {
    this.answer = 'cancel';
    void this.accept();
    return true;
  }
}
