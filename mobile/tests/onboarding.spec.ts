import { expect, test, type Page, type Route } from '@playwright/test';
import {
  computers,
  corsHeaders as cors,
  fixtureHost,
  openApp,
  pairingCode,
  pairingLinkPath,
} from './fixtures/app';
import { ROUTE_HEADER } from './fixtures/relay';

const OVERLAP = /Re-pairs|Replaces your other|Keeps both/;
/** The Camera link for the second computer, as if scanned from its Settings → Mobile. */
const secondLink = () =>
  pairingLinkPath(fixtureHost, {
    route: computers.second.route,
    key: computers.second.key,
    machine: computers.second.machineName,
  });
const shot = (page: Page, state: string, scheme = 'dark') =>
  page.screenshot({ path: `test-results/onboarding-${state}-${scheme}.png` });

/** With nothing on the clipboard, Paste pairing code opens the field for a manual paste. */
async function pasteCode(page: Page, code = pairingCode()) {
  await page.getByRole('button', { name: 'Paste pairing code' }).click();
  await page.getByRole('textbox', { name: 'Pairing code', exact: true }).fill(code);
}

/** Replaces the mocked Mac's answer to the pairing request. */
function answerPair(page: Page, answer: (route: Route) => Promise<void>) {
  return page.route(`${fixtureHost}/pair`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : answer(route),
  );
}

test('pairs by pasting a code, naming the Mac before connecting', async ({ page }) => {
  await openApp(page, { paired: false });
  await expect(page.getByRole('heading', { name: 'Your Mac, in your pocket' })).toBeVisible();
  await expect(page.getByText('Open Frink on your Mac')).toBeVisible();
  await shot(page, 'connect');
  await page.getByRole('button', { name: 'Paste pairing code' }).click();
  await expect(page.getByText('Open Frink on your Mac')).toHaveCount(0);
  await shot(page, 'paste');
  const pairBody = page.waitForRequest(
    (request) => request.url().endsWith('/pair') && request.method() === 'POST',
  );
  await page.getByRole('textbox', { name: 'Pairing code', exact: true }).fill(pairingCode());
  await expect(page.getByRole('heading', { name: 'Connect to mobile-fixture?' })).toBeVisible();
  await expect(page.getByText('End-to-end encrypted via mobile-fixture.example.test', { exact: true })).toBeVisible();
  await expect(page.getByText('Only connect if this is your Mac.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'This iPhone’s name' })).toHaveValue('My iPhone');
  await shot(page, 'confirm');
  await page.getByRole('textbox', { name: 'This iPhone’s name' }).fill('Benji’s iPhone');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect((await pairBody).postDataJSON()).toEqual({ code: 'a'.repeat(43), name: 'Benji’s iPhone' });
  await expect(page.getByTestId('tab-queue')).toBeVisible();
});

test('a pairing link opens straight onto confirming the Mac, and connects only on Connect', async ({
  page,
}) => {
  let pairs = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/pair') && request.method() === 'POST') pairs += 1;
  });
  await openApp(page, { paired: false, path: pairingLinkPath() });
  await expect(page.getByRole('heading', { name: 'Connect to mobile-fixture?' })).toBeVisible();
  await expect(page.getByText(OVERLAP)).toHaveCount(0);
  await shot(page, 'link-confirm');
  expect(pairs).toBe(0);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(() => pairs).toBe(1);
  await expect(page.getByTestId('tab-queue')).toBeVisible();
});

test('a pairing link on a paired iPhone adds the computer and keeps the first', async ({ page }) => {
  await openApp(page, { path: secondLink() });
  await expect(page.getByRole('heading', { name: 'Connect to Studio Mac?' })).toBeVisible();
  await expect(page.getByText(OVERLAP)).toHaveCount(0);
  await page.waitForTimeout(500); // the sheet's slide-in
  await shot(page, 'link-add');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByTestId('tab-queue')).toBeVisible();
  await page.getByTestId('tab-settings').click();
  const list = page.getByTestId('settings-computers');
  await expect(list.getByText("Benji's MacBook Pro")).toBeVisible();
  // The newly added computer is the one shown.
  await expect(list.getByLabel('Studio Mac, shown')).toBeVisible();
});

test('Cancel on a pairing link keeps the app as it was', async ({ page }) => {
  await openApp(page, { path: secondLink() });
  await expect(page.getByRole('heading', { name: 'Connect to Studio Mac?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('tab-queue')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect to Studio Mac?' })).toHaveCount(0);
});

test('a new link from a computer already paired re-pairs it', async ({ page }) => {
  await openApp(page, { path: pairingLinkPath() });
  await expect(page.getByRole('heading', { name: 'Connect to mobile-fixture?' })).toBeVisible();
  await expect(page.getByText('Re-pairs mobile-fixture')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await page.waitForTimeout(500); // the sheet's slide-in
  await shot(page, 'link-same-mac');
});

test('a reset computer with the same name replaces its old pairing unless both are kept', async ({
  page,
}) => {
  const resetLink = pairingLinkPath('https://reset.example.test', {
    machine: computers.first.machineName,
  });
  await openApp(page, { path: resetLink });
  await expect(page.getByText("Replaces your other Benji's MacBook Pro")).toBeVisible();
  await page.waitForTimeout(500); // the sheet's slide-in
  await shot(page, 'link-namesake');
  await page.getByRole('button', { name: 'Keep both' }).click();
  await expect(page.getByText("Keeps both Benji's MacBook Pro pairings")).toBeVisible();
  await page.getByRole('button', { name: 'Replace it instead' }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByTestId('tab-queue')).toBeVisible();
  await page.getByTestId('tab-settings').click();
  await expect(
    page.getByTestId('settings-computers').getByText("Benji's MacBook Pro"),
  ).toHaveCount(1);
});

test('a broken pairing link says what is wrong', async ({ page }) => {
  await openApp(page, { paired: false, path: '/pair?relay=http%3A%2F%2Fmac.test&code=a&v=3' });
  await expect(page.getByText(/This isn’t a full pairing code/)).toBeVisible();
  await shot(page, 'link-broken');
});

test('explains a paste that is not a full code, and a code from another Frink version', async ({
  page,
}) => {
  await openApp(page, { paired: false });
  await pasteCode(page, '{"version":2,"url":"https://mac.test/"');
  await expect(page.getByText(/This isn’t a full pairing code/)).toBeVisible();
  await shot(page, 'paste-invalid');
  await page
    .getByRole('textbox', { name: 'Pairing code', exact: true })
    .fill(JSON.stringify({ version: 1, url: `${fixtureHost}/`, code: 'a'.repeat(43) }));
  await expect(page.getByText('Update Frink on your Mac, then make a new code.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
});

test('an unreachable Mac is named in plain words and the code is kept to retry', async ({
  page,
}) => {
  await openApp(page, { paired: false });
  await answerPair(page, (route) => route.abort('connectionrefused'));
  await pasteCode(page);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(
    page.getByText('Can’t reach your Mac. Keep Frink open and your Mac awake and online, then try again.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  await shot(page, 'unreachable');
});

test('an expired code asks for a new one, and back returns to the first step', async ({ page }) => {
  await openApp(page, { paired: false });
  await answerPair(page, (route) =>
    route.fulfill({
      status: 401,
      headers: cors,
      json: { error: 'Pairing code expired or already used.' },
    }),
  );
  await pasteCode(page);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText(/This code has expired or was already used/)).toBeVisible();
  await page.getByRole('button', { name: 'Use a different code' }).click();
  await expect(page.getByRole('heading', { name: 'Your Mac, in your pocket' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Pairing code', exact: true })).toHaveValue('');
});

test('a Mac on another Frink version asks for an update', async ({ page }) => {
  await openApp(page, { paired: false });
  await answerPair(page, (route) =>
    route.fulfill({
      headers: cors,
      json: { token: 'b'.repeat(43), deviceId: 'd', machineName: 'Mac', apiVersion: 1 },
    }),
  );
  await pasteCode(page);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Update Frink on your Mac, then make a new code.')).toBeVisible();
});

test('a revoked iPhone lands back on pairing with the reason', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('tab-queue')).toBeVisible();
  await page.route(`${fixtureHost}/api`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 401, headers: cors, json: { error: 'Access was revoked.' } }),
  );
  await page.clock.runFor(3500);
  await expect(page.getByText('This iPhone was disconnected')).toBeVisible();
  await expect(
    page.getByText('Your Mac stopped accepting it. Make a new code in Frink on your Mac: Settings → Mobile.'),
  ).toBeVisible();
  await expect(page.getByTestId('tab-queue')).toHaveCount(0);
  await shot(page, 'revoked');
});

test('a revoked computer is dropped even when this iPhone can’t store that', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('tab-queue')).toBeVisible();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error('storage full');
    };
  });
  await page.route(`${fixtureHost}/api`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 401, headers: cors, json: { error: 'Access was revoked.' } }),
  );
  await page.clock.runFor(3500);
  await expect(page.getByText('This iPhone was disconnected')).toBeVisible();
  await expect(page.getByTestId('tab-queue')).toHaveCount(0);
});

test('a computer that revokes this iPhone is dropped, naming it, and the next one is shown', async ({
  page,
}) => {
  await openApp(page, { second: true });
  await expect(page.getByTestId('tab-queue')).toBeVisible();
  await page.route(`${fixtureHost}/api`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.request().headers()[ROUTE_HEADER] === computers.first.route
        ? route.fulfill({ status: 401, headers: cors, json: { error: 'Access was revoked.' } })
        : route.fallback(),
  );
  const notice = page.waitForEvent('dialog');
  await page.clock.runFor(3500);
  const dialog = await notice;
  expect(dialog.message()).toMatch(/^Benji's MacBook Pro stopped accepting this iPhone/);
  await dialog.accept();
  await page.getByTestId('tab-settings').click();
  const list = page.getByTestId('settings-computers');
  await expect(list.getByText('Studio Mac')).toBeVisible();
  await expect(list.getByText("Benji's MacBook Pro")).toHaveCount(0);
});

test('the scanner offers the paste fallback when the camera is unavailable', async ({ page }) => {
  await openApp(page, { paired: false });
  await page.getByRole('button', { name: 'Scan pairing code' }).click();
  await expect(page.getByText('Camera access is off')).toBeVisible();
  await shot(page, 'camera-off');
  await page.getByRole('button', { name: 'Paste pairing code' }).last().click();
  await expect(page.getByRole('textbox', { name: 'Pairing code', exact: true })).toBeFocused();
});

test.describe('with a clipboard', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
  const copy = (page: Page, text: string) =>
    page.evaluate((value) => navigator.clipboard.writeText(value), text);

  test('a copied code goes straight to confirming the Mac', async ({ page }) => {
    await openApp(page, { paired: false });
    await copy(page, pairingCode());
    await page.getByRole('button', { name: 'Paste pairing code' }).click();
    await expect(page.getByRole('heading', { name: 'Connect to mobile-fixture?' })).toBeVisible();
  });

  test('anything else opens the field with it, saying what is wrong', async ({ page }) => {
    await openApp(page, { paired: false });
    await copy(page, 'hello from my notes');
    await page.getByRole('button', { name: 'Paste pairing code' }).click();
    const field = page.getByRole('textbox', { name: 'Pairing code', exact: true });
    await expect(field).toHaveValue('hello from my notes');
    await expect(page.getByText(/This isn’t a full pairing code/)).toBeVisible();
  });
});

test.describe('on a small iPhone', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('the pasted code and its problem stay above where the keyboard opens', async ({ page }) => {
    await openApp(page, { paired: false });
    await pasteCode(page, 'not a code');
    const field = await page.getByRole('textbox', { name: 'Pairing code', exact: true }).boundingBox();
    const problem = await page.getByText(/This isn’t a full pairing code/).boundingBox();
    expect(field!.y + field!.height).toBeLessThan(380);
    expect(problem!.y).toBeLessThan(380);
    await shot(page, 'paste-small');
  });
});

test('light appearance', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openApp(page, { paired: false });
  await expect(page.getByRole('heading', { name: 'Your Mac, in your pocket' })).toBeVisible();
  await shot(page, 'connect', 'light');
  await pasteCode(page);
  await shot(page, 'confirm', 'light');
});

test.describe('with a camera', () => {
  test.use({ permissions: ['camera'] });
  // Headless Chromium has no camera: stand one in with a painted canvas stream.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 390, height: 844 });
        const context = canvas.getContext('2d')!;
        const gradient = context.createLinearGradient(0, 0, 390, 844);
        gradient.addColorStop(0, '#3a3f47');
        gradient.addColorStop(1, '#15171a');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 390, 844);
        return canvas.captureStream();
      };
    });
  });

  test('the scanner shows the viewfinder, and closes back to the first step', async ({ page }) => {
    await openApp(page, { paired: false });
    await page.getByRole('button', { name: 'Scan pairing code' }).click();
    await expect(page.getByText('Scan the code on your Mac')).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, 'scanner');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('heading', { name: 'Your Mac, in your pocket' })).toBeVisible();
  });
});
