// Shared steps for the browser and Electron checks.

/** Waits for the Theia shell, runs `qe.hello` via the command palette and returns timings + message. */
export async function runHelloCommand(page, expectedTarget) {
  const started = Date.now();
  await page.waitForSelector('#theia-app-shell', { timeout: 90_000 });
  await page.waitForSelector('.theia-preload', { state: 'detached', timeout: 90_000 });
  const shellReadyMs = Date.now() - started;

  // Theia asks whether to trust a newly opened workspace folder; the dialog takes focus.
  const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
  const trustPrompted = await trust
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (trustPrompted) {
    await trust.click();
    await trust.waitFor({ state: 'detached' });
  }

  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  // Monaco's quick input reacts to key events, not to a programmatic value change.
  await page.keyboard.type('QE: Say Hello');
  const row = page.locator('.quick-input-widget .monaco-list-row', { hasText: 'QE: Say Hello' }).first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();

  // The message is rendered in the toast and in the (hidden) notification centre; check the visible one.
  const expected = `Hello from QE Workspace (${expectedTarget})`;
  const toast = page
    .locator('.theia-notification-message', { hasText: expected })
    .filter({ visible: true })
    .first();
  await toast.waitFor({ timeout: 15_000 });
  return { shellReadyMs, trustPrompted, message: (await toast.innerText()).trim() };
}

/**
 * Opens an integrated terminal and runs a command that writes `markerFile`; the caller checks the file.
 * Proves the backend loaded node-pty and spawned a shell (in Electron: under Electron's Node ABI).
 */
export async function runTerminalCommand(page, markerFile) {
  await page.keyboard.press('F1');
  await page.locator('.quick-input-widget input').waitFor({ state: 'visible', timeout: 15_000 });
  await page.keyboard.type('Terminal: Create New Terminal');
  const row = page
    .locator('.quick-input-widget .monaco-list-row', { hasText: 'Terminal: Create New Terminal' })
    .first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await page.locator('.terminal-container .xterm').first().waitFor({ timeout: 30_000 });
  await page.locator('.terminal-container .xterm-helper-textarea').first().focus();
  await page.keyboard.type(`echo QE_TERMINAL_OK > ${markerFile}`);
  await page.keyboard.press('Enter');
}
