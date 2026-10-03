const PREPARE_TIMEOUT_MS = 30_000;

/** Navigate to the stable Settings surface; Qavis/Midscene owns the changed-behaviour assertion. */
export async function prepare({ page }) {
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  await settingsButton.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await settingsButton.click();
  await page
    .getByRole('navigation', { name: 'Settings navigation', exact: true })
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
}
