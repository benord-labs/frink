const PREPARE_TIMEOUT_MS = 30_000;
const FIXTURE_FLOW_NAME = 'Plugin node QA flow';
const CALL_TOOL_STEP = /^Step \d+: Call any PostHog tool$/;

/**
 * Open the seeded plugin-node flow on its generic call-tool step so its config panel is on screen;
 * the curated List PostHog errors step sits beside it for the driver to select. The fields are the
 * claims under test and stay untouched here.
 */
export async function prepare({ page }) {
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  const flowRow = page.getByText(FIXTURE_FLOW_NAME, { exact: true });
  await flowRow.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await flowRow.click();
  const step = page.getByRole('button', { name: CALL_TOOL_STEP });
  await step.waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
  await step.click();
  await page
    .getByLabel('Display name', { exact: true })
    .waitFor({ state: 'visible', timeout: PREPARE_TIMEOUT_MS });
}
