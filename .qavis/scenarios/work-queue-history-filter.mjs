const PREPARE_TIMEOUT_MS = 30_000;
const WORK_QUEUE_BUTTON_NAME = /^Work Queue\./;

export async function prepare({ page }) {
  const workQueueButton = page.getByRole('button', { name: WORK_QUEUE_BUTTON_NAME });
  await workQueueButton.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await workQueueButton.click();

  const viewHistoryButton = page.getByRole('button', {
    name: 'View task history',
    exact: true,
  });
  await viewHistoryButton.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await viewHistoryButton.click();

  await page
    .getByRole('heading', { name: 'History', exact: true })
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await page
    .getByText('Completed history example', { exact: true })
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await page
    .getByText('Cancelled history example', { exact: true })
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
}
