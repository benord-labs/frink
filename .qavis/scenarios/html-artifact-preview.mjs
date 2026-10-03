const PREPARE_TIMEOUT_MS = 30_000;
const FIXTURE_PROJECT_NAME = /QA Fixture/;
const SEEDED_CHAT = '#sidebar-item-qa-fixture-chat-seeded';
const PRE_EXISTING_TRANSCRIPT =
  'The project contains src, scripts, docs and relay at the top level.';

/** Open the seeded chat so visual QA begins on the collapsed artifact in its real transcript. */
export async function prepare({ page }) {
  const projectRow = page.getByRole('treeitem', { name: FIXTURE_PROJECT_NAME });
  await projectRow.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  if ((await projectRow.getAttribute('aria-expanded')) !== 'true') await projectRow.click();
  const chatRow = page.locator(SEEDED_CHAT);
  await chatRow.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await chatRow.getByRole('button').first().click();
  await page
    .getByText(PRE_EXISTING_TRANSCRIPT, { exact: true })
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  const runArtifact = page.getByRole('button', { name: 'Run artifact', exact: true });
  await runArtifact.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
}
