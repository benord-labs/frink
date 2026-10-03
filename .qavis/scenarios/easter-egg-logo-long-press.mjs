const PREPARE_TIMEOUT_MS = 30_000;
const BADGE_TIMEOUT_MS = 10_000;
const LONG_PRESS_MS = 3_800;

/**
 * Hold the sidebar wordmark past the 3.5 s long-press threshold, then hand over. The badge that
 * appears stays until dismissed; a base build that cannot show it hands over the plain app instead.
 */
export async function prepare({ page }) {
  const logo = page.getByRole('img', { name: 'Frink', exact: true }).first();
  await logo.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  const box = await logo.boundingBox();
  if (!box) throw new Error('sidebar wordmark has no bounding box');

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(LONG_PRESS_MS);
  await page.mouse.up();

  await page
    .locator('[data-testid="ee-floating-badge-layer"]')
    .waitFor({ state: 'visible', timeout: BADGE_TIMEOUT_MS })
    .catch(() => undefined);
}
