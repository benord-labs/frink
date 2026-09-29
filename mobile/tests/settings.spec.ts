import { expect, test, type Page } from '@playwright/test';
import { openApp } from './fixtures/app';
import { overviewFixture } from './fixtures/data';

const shot = (page: Page, state: string, scheme = 'dark') =>
  page.screenshot({ path: `test-results/settings-${state}-${scheme}.png` });

async function openSettings(page: Page, options: Parameters<typeof openApp>[1] = {}) {
  const state = await openApp(page, options);
  await page.getByTestId('tab-settings').click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  return state;
}

test('shows the paired Mac, the app version and how to forget it', async ({ page }) => {
  await openSettings(page);
  const mac = page.getByTestId('mac-identity');
  await expect(mac.getByText("Benji's MacBook Pro")).toBeVisible();
  await expect(mac.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByText('This Mac', { exact: true })).toBeVisible();
  await expect(page.getByText('0.0.13')).toBeVisible();
  await expect(page.getByText('mobile-fixture.example.test')).toBeVisible();
  await expect(page.getByText('This iPhone', { exact: true })).toBeVisible();
  await expect(page.getByText('Frink version', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Forget this Mac' })).toBeVisible();
  await expect(page.getByText(/remove this iPhone under Paired phones/)).toBeVisible();
  await shot(page, 'connected');
});

test('says when Frink is not open on the Mac', async ({ page }) => {
  await openSettings(page, { data: { overview: { ...overviewFixture(), executionReady: false } } });
  await expect(page.getByText('Frink isn’t open on your Mac')).toBeVisible();
  await expect(page.getByText('Open Frink on your Mac to run chats.')).toBeVisible();
  await shot(page, 'not-ready');
});

test('says when the Mac cannot be reached, keeping what it last sent', async ({ page }) => {
  const state = await openSettings(page);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  state.offline = true;
  await page.clock.runFor(3500);
  const mac = page.getByTestId('mac-identity');
  await expect(mac.getByText('Offline', { exact: true })).toBeVisible();
  await expect(mac.getByText(/Check Tailscale is on/)).toBeVisible();
  await expect(mac.getByText('Can’t reach your Mac')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' }).last()).toBeVisible();
  await expect(page.getByText('0.0.13')).toBeVisible();
  await shot(page, 'offline');
});

test('a Mac that answers with an error is not blamed on the network', async ({ page }) => {
  await openSettings(page, {
    respond: (input) =>
      input.type === 'overview' ? new Error('Frink couldn’t load its projects.') : undefined,
  });
  const mac = page.getByTestId('mac-identity');
  await expect(mac.getByText('Having trouble', { exact: true })).toBeVisible();
  await expect(mac.getByText(/Tailscale/)).toHaveCount(0);
  await expect(page.getByText('Couldn’t refresh').last()).toBeVisible();
  await shot(page, 'server-error');
});

test('forgetting the Mac asks first, then returns to pairing', async ({ page }) => {
  await openSettings(page);
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByRole('button', { name: 'Forget this Mac' }).click();
  await expect(page.getByTestId('mac-identity')).toBeVisible();
  let message = '';
  page.once('dialog', (dialog) => {
    message = dialog.message();
    void dialog.accept();
  });
  await page.getByRole('button', { name: 'Forget this Mac' }).click();
  await expect(page.getByRole('heading', { name: 'Your Mac, in your pocket' })).toBeVisible();
  expect(message).toMatch(/^Forget this Mac\?/);
  expect(await page.evaluate(() => sessionStorage.getItem('frink.mobile.connection'))).toBeNull();
});

test('light appearance', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openSettings(page);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await shot(page, 'connected', 'light');
});

test('the Lock Screen card is offered only in the iPhone app, not in a browser', async ({ page }) => {
  await openSettings(page);
  await expect(page.getByText('When a chat finishes')).toBeVisible();
  await expect(page.getByText('Show on Lock Screen')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/live-activity-web-hidden-dark.png' });
});
