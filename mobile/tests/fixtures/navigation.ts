import { expect, type Page } from '@playwright/test';

/** Returns through the native stack so every destination is reached through its visible entry. */
export async function openHistory(page: Page) {
  const history = page.getByTestId('history-open');
  await history
    .or(page.getByRole('link', { name: /back/i }))
    .filter({ visible: true })
    .first()
    .waitFor();
  while (!(await history.isVisible())) {
    const back = page.getByRole('link', { name: /back/i });
    const previous = await back.elementHandle();
    await back.click();
    await previous?.waitForElementState('hidden');
  }
  await history.click();
  await expect(page.getByTestId('history-panel')).toBeVisible();
}

export async function openDestination(page: Page, name: 'Queue' | 'Flows' | 'Settings') {
  await openHistory(page);
  await page
    .getByTestId('history-panel')
    .getByRole('button', { name: name === 'Queue' ? /^Queue(?:,|$)/ : name, exact: true })
    .click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
