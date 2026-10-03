const PREPARE_TIMEOUT_MS = 30_000;
const OFFER_TIMEOUT_MS = 5_000;

/**
 * Open the PostHog plugin page and bring its Triggers card on screen. PostHog has no account of its
 * own, so the page offers to set the trigger up; taking that offer mints the endpoint row the card
 * reads, which is why prepare presses it when it is there. Everything after that — the one-line
 * state, the event list, the test control and the folded Advanced panel — is the claim.
 */
export async function prepare({ page }) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: 'Settings navigation', exact: true });
  await navigation.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await navigation.getByRole('button', { name: 'Plugins', exact: true }).click();

  const posthogRow = page.locator('[data-plugin-row="posthog"] button');
  await posthogRow.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await posthogRow.click();

  await page
    .getByRole('heading', { name: 'Triggers', exact: true })
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });

  const offer = page.getByRole('button', { name: 'Set up automatically', exact: true });
  await offer.waitFor({ state: 'visible', timeout: OFFER_TIMEOUT_MS }).catch(() => {});
  if (await offer.isVisible().catch(() => false)) {
    await offer.click();
  }

  await page
    .getByRole('button', { name: 'Send a test event', exact: true })
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
}
