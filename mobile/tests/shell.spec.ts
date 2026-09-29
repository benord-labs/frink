import { expect, test } from '@playwright/test';
import { openApp } from './fixtures/app';

test('the four tabs switch and the Queue tab shows the needs-you badge', async ({ page }) => {
  await openApp(page);
  for (const tab of ['queue', 'chats', 'flows', 'settings']) {
    await page.getByTestId(`tab-${tab}`).click();
    await page.screenshot({ path: `test-results/shell-${tab}.png` });
  }
  // Four decisions and attention tasks, plus the finished task.
  await expect(page.getByTestId('tab-queue')).toContainText('5');
});
