const PREPARE_TIMEOUT_MS = 30_000;
const FIXTURE_PROJECT_NAME = /QA Fixture/;
const INTERRUPTED_CHAT = '#sidebar-item-qa-fixture-chat-flow-interrupted';
const CUT_OFF_LINE = 'Converting the first three fields — starting with the';

/** Open the interrupted flow chat whose resume ticket is queued behind the concurrency cap. */
export async function prepare({ page }) {
  const projectRow = page.getByRole('treeitem', { name: FIXTURE_PROJECT_NAME });
  await projectRow.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  if ((await projectRow.getAttribute('aria-expanded')) !== 'true') await projectRow.click();
  const chatRow = page.locator(INTERRUPTED_CHAT);
  await chatRow.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await chatRow.getByRole('button').first().click();
  await page
    .getByText(CUT_OFF_LINE, { exact: true })
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await page
    .getByText('Flow run interrupted', { exact: true })
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
}
