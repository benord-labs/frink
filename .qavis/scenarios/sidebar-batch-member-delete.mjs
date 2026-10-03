const PREPARE_TIMEOUT_MS = 30_000;
const MEMBER_ROW = '#sidebar-item-qa-fixture-chat-batch-member-a';

/** Expand the seeded batch group and open one member's row menu; the driver performs the delete. */
export async function prepare({ page }) {
  const header = page.locator('.sidebar-batch-tree-header', { hasText: 'Batch QA flow' }).first();
  await header.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await header.click();
  const row = page.locator(MEMBER_ROW);
  await row.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await row.hover();
  await row.getByRole('button', { name: 'Chat actions' }).click();
}
