const PREPARE_TIMEOUT_MS = 30_000;
const FIXTURE_PROJECT_NAME = /QA Fixture/;
const SEEDED_CHAT = '#sidebar-item-qa-fixture-chat-seeded';
const PRE_EXISTING_TRANSCRIPT =
  'The project contains src, scripts, docs and relay at the top level.';
// The default per-chat model id is 'sonnet' (lastSelectedModelIdAtomFamily's default value),
// unaffected by the catalog additions this scenario covers — a stable "closed picker" precondition.
const DEFAULT_MODEL_TRIGGER_NAME = /^Sonnet 4\.6$/;

/**
 * Open the seeded chat and wait for the composer's model picker trigger — closed, showing the
 * unaffected default selection ("Sonnet 4.6"). The catalog contents and the picker's own behaviour
 * (new families, hint text, effort variants, trigger label update) are the changed behaviour under
 * test and are asserted by the claims, not opened here.
 */
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
  const modelTrigger = page.getByRole('button', { name: DEFAULT_MODEL_TRIGGER_NAME });
  await modelTrigger.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
}
