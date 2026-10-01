import { expect, test, type Page } from '@playwright/test';
import { openApp } from './fixtures/app';

const shot = (page: Page, state: string, scheme = 'dark') =>
  page.screenshot({ path: `test-results/notifications-${state}-${scheme}.png` });
const alertSwitch = (page: Page) =>
  page.getByRole('switch', { name: 'Alerts' });
// On web the list row around the switch reports itself disabled (it has no tap action of its own),
// which Playwright's enabled check inherits; the switch itself still takes the tap.
const tapSwitch = (page: Page) => alertSwitch(page).click({ force: true });

async function openSettings(page: Page) {
  const state = await openApp(page);
  await page.getByTestId('tab-settings').click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  return state;
}

test('offers chat-finished alerts in Settings, off until asked', async ({ page }) => {
  const state = await openSettings(page);
  await expect(page.getByText('Notifications', { exact: true })).toBeVisible();
  await expect(page.getByText('Alerts', { exact: true })).toBeVisible();
  await expect(page.getByText(/needs you or finishes\. Your prompts and code stay on your Mac/)).toBeVisible();
  await expect(alertSwitch(page)).not.toBeChecked();
  // Opening Settings only reads the registration; it never registers or prompts.
  expect(state.alerts).toEqual([{}]);
  await shot(page, 'off');
});

test('a refused permission says where to allow alerts', async ({ page, context }) => {
  await context.clearPermissions();
  const state = await openSettings(page);
  await page.evaluate(() => {
    Notification.requestPermission = async () => 'denied';
  });
  await tapSwitch(page);
  await expect(page.getByText(/Alerts are off for Frink in iPhone Settings/)).toBeVisible();
  await expect(alertSwitch(page)).not.toBeChecked();
  expect(state.alerts.some((alert) => alert.token)).toBe(false);
  await shot(page, 'blocked');
});

test('says when the Mac could not reach this iPhone', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openApp(page, {
    notifications: {
      enabled: false,
      error: 'Your Mac couldn’t reach this iPhone. Turn this on again to keep getting alerts.',
    },
  });
  await page.getByTestId('tab-settings').click();
  await expect(page.getByText(/couldn’t reach this iPhone/)).toBeVisible();
  await shot(page, 'delivery-failed', 'light');
});

test('forgetting the Mac also asks it to stop alerts', async ({ page }) => {
  const state = await openSettings(page);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Forget this Mac' }).click();
  await expect(page.getByRole('heading', { name: 'Your Mac, in your pocket' })).toBeVisible();
  await expect.poll(() => state.alerts.at(-1)).toEqual({ token: null });
});
