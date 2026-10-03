const PREPARE_TIMEOUT_MS = 30_000;
const SEEDED_CHAT = '#sidebar-item-qa-fixture-chat-seeded';

/**
 * Open a seeded chat and leave the slash-command dropdown listing the Slack fixture commands.
 * The composer is a contenteditable the driver cannot type into, so preparation gets the list on
 * screen and stops. What happens after a row is picked is the behaviour under test.
 */
export async function prepare({ page }) {
  const chat = page.locator(SEEDED_CHAT);
  await chat.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await chat.click();

  // focus(), not click(): the composer sits under an overlay that fails Playwright's
  // actionability hit-test, and the caret is all the keystrokes need.
  const composer = page.locator('[data-chat-input="true"]').first();
  await composer.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await composer.focus();
  await page.keyboard.type('/slack:', { delay: 25 });

  await page
    .locator('[role="option"]')
    .first()
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
}
