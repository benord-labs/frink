import { openDestination } from './fixtures/navigation';
import { expect, test, type Page } from '@playwright/test';
import { computers, openApp } from './fixtures/app';
import { conversation, messageBox, openChat } from './fixtures/chat';
import { overviewFixture } from './fixtures/data';

const shot = (page: Page, state: string, scheme = 'dark') =>
  page.screenshot({ path: `test-results/settings-${state}-${scheme}.png` });

async function openSettings(page: Page, options: Parameters<typeof openApp>[1] = {}) {
  const state = await openApp(page, options);
  await openDestination(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  return state;
}

async function setAppearance(page: Page, mode: 'System' | 'Light' | 'Dark') {
  await page.getByRole('button', { name: /^Appearance: / }).click();
  await page.getByRole('radio', { name: mode, exact: true }).click();
}

test('shows the paired Mac, both versions and how to forget it, in framed cards', async ({
  page,
}) => {
  await openSettings(page);
  const mac = page.getByTestId('mac-identity');
  await expect(mac.getByText("Benji's MacBook Pro")).toBeVisible();
  await expect(mac.getByText('Connected', { exact: true })).toBeVisible();
  const about = page.getByTestId('settings-about');
  await expect(page.getByText('About', { exact: true })).toBeVisible();
  await expect(about.getByText('Frink on your Mac', { exact: true })).toBeVisible();
  await expect(about.getByText('0.0.13')).toBeVisible();
  await expect(about.getByText('Frink on this iPhone', { exact: true })).toBeVisible();
  // One card per topic: the old "This Mac" / "This iPhone" groups and the network address are gone.
  await expect(page.getByText('This Mac', { exact: true })).toHaveCount(0);
  await expect(page.getByText('This iPhone', { exact: true })).toHaveCount(0);
  await expect(page.getByText('mobile-fixture.example.test')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Forget this Mac' })).toBeVisible();
  // How to fully revoke access is said once, in the confirm, not under the button.
  await expect(page.getByText(/remove this iPhone under Paired phones/)).toHaveCount(0);
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
  await expect(mac.getByText(/Keep Frink open/)).toBeVisible();
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
  await expect(mac.getByText(/awake and online/)).toHaveCount(0);
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
  expect(message).toMatch(/remove this iPhone under Paired phones/);
  expect(
    await page.evaluate(
      (id) => sessionStorage.getItem(`frink.mobile.computer.${id}`),
      computers.first.deviceId,
    ),
  ).toBeNull();
});

test('lists every paired computer and switches to another with a tap', async ({ page }) => {
  await openSettings(page, { second: true });
  const list = page.getByTestId('settings-computers');
  await expect(list.getByLabel("Benji's MacBook Pro, shown")).toBeVisible();
  await expect(list.getByText(/^Paired .*2026$/).first()).toBeVisible();
  await shot(page, 'computers');
  await list.getByRole('button', { name: 'Studio Mac' }).click();
  await openDestination(page, 'Settings');
  await expect(
    page.getByTestId('settings-computers').getByLabel('Studio Mac, shown'),
  ).toBeVisible();
});

test('Add a computer opens pairing over the app, and Cancel keeps everything', async ({ page }) => {
  await openSettings(page);
  await page.getByRole('button', { name: 'Add a computer' }).click();
  await expect(page.getByRole('button', { name: 'Paste pairing code' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.getByTestId('settings-computers').getByText("Benji's MacBook Pro"),
  ).toBeVisible();
});

test('forgetting the shown computer moves to the other one', async ({ page }) => {
  await openSettings(page, { second: true });
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Forget this Mac' }).click();
  await expect(page.getByTestId('history-open')).toBeVisible();
  await openDestination(page, 'Settings');
  const list = page.getByTestId('settings-computers');
  await expect(list.getByLabel('Studio Mac, shown')).toBeVisible();
  await expect(list.getByText("Benji's MacBook Pro")).toHaveCount(0);
});

test('light appearance', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openSettings(page);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await shot(page, 'connected', 'light');
});

test('manual appearance overrides the device and survives navigation, computer changes and reload', async ({
  page,
}) => {
  await openSettings(page, { second: true });
  const title = page.getByRole('heading', { name: 'Settings', exact: true });
  await expect(page.getByRole('button', { name: 'Appearance: System', exact: true })).toBeVisible();
  await setAppearance(page, 'Light');
  await expect(title).toHaveCSS('color', 'rgb(10, 10, 10)');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, 'manual', 'light');
  await setAppearance(page, 'Dark');
  await expect(title).toHaveCSS('color', 'rgb(232, 232, 232)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'manual', 'dark');
  await openDestination(page, 'Queue');
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toHaveCSS(
    'color',
    'rgb(232, 232, 232)',
  );
  await openDestination(page, 'Settings');
  await page.getByTestId('settings-computers').getByRole('button', { name: 'Studio Mac' }).click();
  await openDestination(page, 'Settings');
  await expect(page.getByRole('button', { name: 'Appearance: Dark', exact: true })).toBeVisible();
  await page.reload();
  await openDestination(page, 'Settings');
  await expect(page.getByRole('button', { name: 'Appearance: Dark', exact: true })).toBeVisible();
  await expect(title).toHaveCSS('color', 'rgb(232, 232, 232)');
});

test('System restores the current device appearance and follows later device changes', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openSettings(page);
  const title = page.getByRole('heading', { name: 'Settings', exact: true });
  await setAppearance(page, 'Dark');
  await expect(title).toHaveCSS('color', 'rgb(232, 232, 232)');
  await setAppearance(page, 'System');
  await expect(page.getByRole('button', { name: 'Appearance: System', exact: true })).toBeVisible();
  await expect(title).toHaveCSS('color', 'rgb(10, 10, 10)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(title).toHaveCSS('color', 'rgb(232, 232, 232)');
});

test('an invalid saved appearance falls back to the device appearance', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('frink.mobile.appearance.v1', 'invalid'));
  await openSettings(page);
  await expect(page.getByRole('button', { name: 'Appearance: System', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCSS(
    'color',
    'rgb(232, 232, 232)',
  );
});

test('appearance remains usable when preference storage cannot be read or written', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const read = Storage.prototype.getItem;
    const write = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'frink.mobile.appearance.v1') throw new Error('Storage unavailable');
      return read.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'frink.mobile.appearance.v1') throw new Error('Storage unavailable');
      return write.call(this, key, value);
    };
  });
  await openSettings(page);
  await expect(page.getByRole('button', { name: 'Appearance: System', exact: true })).toBeVisible();
  await setAppearance(page, 'Light');
  await expect(page.getByRole('button', { name: 'Appearance: Light', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCSS(
    'color',
    'rgb(10, 10, 10)',
  );
  expect(errors).toEqual([]);
});

test('the Lock Screen card is offered only in the iPhone app, not in a browser', async ({
  page,
}) => {
  await openSettings(page);
  await expect(page.getByRole('switch', { name: 'Alerts' })).toBeVisible();
  await expect(page.getByText('Lock Screen', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/live-activity-web-hidden-dark.png' });
});

test('an off switch keeps a visible track on the framed card', async ({ page }) => {
  await openSettings(page);
  const alerts = page.getByRole('switch', { name: 'Alerts' });
  await expect(alerts).not.toBeChecked();
  // The track is the switch input's first sibling; iOS's own off track is a translucent grey.
  const track = alerts.evaluate(
    (input) => getComputedStyle(input.parentElement!.children[0]!).backgroundColor,
  );
  expect(await track).toBe('rgba(120, 120, 128, 0.36)');
});

test('a half-typed message survives switching to another computer and back', async ({ page }) => {
  await openApp(page, { second: true, data: { chat: conversation() } });
  await openChat(page);
  await messageBox(page).fill('Half-typed note');
  const switchTo = async (name: string) => {
    await openDestination(page, 'Settings');
    await page.getByTestId('settings-computers').getByRole('button', { name }).click();
  };
  await switchTo('Studio Mac');
  await switchTo("Benji's MacBook Pro");
  await openChat(page);
  await expect(messageBox(page)).toHaveValue('Half-typed note');
});

test('all five glass levels can be selected, and the preference survives reload', async ({
  page,
}) => {
  await openSettings(page);
  await expect(page.getByRole('button', { name: 'Transparency: 50%', exact: true })).toBeVisible();
  for (const level of [0, 25, 50, 75, 100]) {
    await page.getByRole('button', { name: /^Transparency: / }).click();
    await page
      .getByRole('radio', { name: level === 0 ? '0% (Solid)' : `${level}%`, exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: `Transparency: ${level}%`, exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('frink.mobile.transparency.v1')))
      .toBe(String(level));
  }
  await page.reload();
  await openDestination(page, 'Settings');
  await expect(page.getByRole('button', { name: 'Transparency: 100%', exact: true })).toBeVisible();
});
