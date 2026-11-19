import { expect, type Locator, type Page } from '@playwright/test';

type Tab = 'Chats' | 'Flows' | 'Queue';

/** A tab bar button; the Queue tab's name starts with its badge count. */
export const tabButton = (page: Page, name: Tab) =>
  page.getByRole('tab', { name: new RegExp(`(^|\\s)${name}$`) });

/** Steps Back, as a reader would, until `target` shows; a Back link may vanish mid-transition. */
async function backUntil(page: Page, target: Locator) {
  const back = page.getByRole('link', { name: /back/i }).filter({ visible: true });
  for (;;) {
    await target.or(back).filter({ visible: true }).first().waitFor();
    if (await target.filter({ visible: true }).count()) return;
    const link = await back
      .first()
      .elementHandle({ timeout: 1000 })
      .catch(() => null);
    // A link replaced during the click is retried on the next pass.
    await link?.click().catch(() => {});
    await link?.waitForElementState('hidden');
  }
}

/** Opens a tab at its root list, the way the tab bar is reached from anywhere. */
export async function openTab(page: Page, name: Tab) {
  await backUntil(page, tabButton(page, name));
  const tab = tabButton(page, name).filter({ visible: true });
  // Tapping the shown tab pops its stack a frame later, which could undo the next tap.
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await backUntil(page, page.getByRole('heading', { name, exact: true }));
}

/** Opens the chat list at the root of the Chats tab. */
export function openHistory(page: Page) {
  return openTab(page, 'Chats');
}

export async function openDestination(page: Page, name: 'Queue' | 'Flows' | 'Settings') {
  if (name === 'Settings') {
    await openTab(page, 'Chats');
    await page.getByTestId('computer-button').filter({ visible: true }).click();
  } else await openTab(page, name);
  await expect(
    page.getByRole('heading', { name, exact: true }).filter({ visible: true }),
  ).toBeVisible();
}
