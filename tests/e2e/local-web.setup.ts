/**
 * Local web mode opens with its sign-in link (PHASE_10 §10.6): this setup opens it once, as the user would, and keeps
 * the cookie for the browser suite (playwright.config.ts).
 */
import { expect, test as setup } from '@playwright/test';

setup('signs in with the run’s link', async ({ request }) => {
  const res = await request.get(`/?token=${process.env['QE_E2E_LOCAL_TOKEN'] ?? ''}`, { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(res.headers()['location']).toBe('/');
  await request.storageState({ path: process.env['QE_E2E_LOCAL_STATE'] ?? '' });
});
