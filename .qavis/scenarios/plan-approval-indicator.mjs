const PREPARE_TIMEOUT_MS = 30_000;
const SEEDED_PLAN_CHAT = '#sidebar-item-qa-fixture-chat-seeded';

/** Wait for the existing plan-ready fixture row; the scenario does not assert the new icon itself. */
export async function prepare({ page }) {
  await page.locator(SEEDED_PLAN_CHAT).waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
}
