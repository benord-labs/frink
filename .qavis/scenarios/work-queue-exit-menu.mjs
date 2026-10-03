// Opens the Work Queue with the seeded interrupted and paused flow rows on screen. The seeded
// runs surface under Needs attention: one is the spotlight card, the other sits in the collapsed
// "Other tasks needing attention" disclosure, which is expanded here so both menus are reachable.
const PREPARE_TIMEOUT_MS = 30_000;
const WORK_QUEUE_BUTTON_NAME = /^Work Queue\./;
const INTERRUPTED_ROW_TEXT = 'interrupted by a restart';
const PAUSED_ROW_TEXT = 'paused, awaiting your resume';

export async function prepare({ page }) {
  const workQueueButton = page.getByRole('button', { name: WORK_QUEUE_BUTTON_NAME });
  await workQueueButton.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await workQueueButton.click();

  const disclosure = page.getByRole('button', { name: /Other tasks needing attention/ });
  await disclosure.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await disclosure.click();

  await page
    .getByText(INTERRUPTED_ROW_TEXT)
    .first()
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await page
    .getByText(PAUSED_ROW_TEXT)
    .first()
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
}
