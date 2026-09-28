import { expect, test } from '@playwright/test';
import { fixtureHost, mockCompanion } from './fixtures/companion';

test('server errors explain why a retained conversation cannot refresh', async ({ page }) => {
  await mockCompanion(page);
  await page.getByRole('tab', { name: 'Chats', exact: true }).click();
  await page.getByText('Prepare the next release', { exact: true }).click();
  await expect(page.getByText('Ready when you are.')).toBeVisible();
  await page.route(`${fixtureHost}/api`, (route) =>
    route.fulfill({
      status: route.request().method() === 'OPTIONS' ? 204 : 404,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type,authorization',
      },
      json: { error: 'This conversation no longer exists.' },
    }),
  );
  await expect(page.getByText('This conversation no longer exists.', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText('Ready when you are.')).toBeVisible();
  await expect(page.getByText('Waiting for your computer', { exact: true })).toHaveCount(0);
});

test('only the visible screen polls and the previous destination returns intact', async ({
  page,
}) => {
  const server = await mockCompanion(page);
  await page.getByRole('tab', { name: 'Chats', exact: true }).click();
  await page.getByText('Prepare the next release', { exact: true }).click();
  await expect(page.getByText('Ready when you are.')).toBeVisible();
  server.requests.length = 0;
  await expect
    .poll(() => server.requests.filter((r) => r.type === 'chat').length, { timeout: 12000 })
    .toBeGreaterThan(0);
  expect(server.requests.filter((r) => r.type === 'chats' || r.type === 'overview')).toEqual([]);
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Chats', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByPlaceholder('Search conversations')).toBeVisible();
});

test('offline refresh keeps the last queue visible and reconnects without replaying actions', async ({
  page,
}) => {
  const queue = [
    {
      id: 'task-1',
      title: 'Review the release notes',
      summary: 'Ready for your review',
      section: 'attention',
      status: 'needs_attention',
      chatId: 'chat-1',
      subChatId: 'sub-1',
      flowRunId: null,
    },
  ];
  const server = await mockCompanion(page, {
    overview: {
      machineName: 'Studio Mac',
      executionReady: true,
      queue,
      questions: [],
      permissions: [],
    },
  });
  await expect(page.getByText('Review the release notes', { exact: true })).toBeVisible();
  server.offline = true;
  await expect(page.getByText('Waiting for your computer', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText('Review the release notes', { exact: true })).toBeVisible();
  server.offline = false;
  await page.getByRole('button', { name: 'Try refreshing again' }).click();
  await expect(page.getByText('Waiting for your computer', { exact: true })).toHaveCount(0);
  expect(server.requests.every((r) => r.type === 'overview')).toBe(true);
});

test('queue search and filters retain the attention-first overview', async ({ page }) => {
  const queue = [
    {
      id: 'task-1',
      title: 'Review release notes',
      summary: 'Ready for review',
      section: 'attention',
      status: 'needs_attention',
      chatId: 'chat-1',
      subChatId: 'sub-1',
      flowRunId: null,
    },
    {
      id: 'task-2',
      title: 'Build the iPhone app',
      summary: 'Compiling on your Mac',
      section: 'running',
      status: 'running',
      chatId: 'chat-2',
      subChatId: 'sub-2',
      flowRunId: null,
    },
  ];
  await mockCompanion(page, {
    overview: {
      machineName: 'Studio Mac',
      executionReady: true,
      queue,
      questions: [],
      permissions: [],
    },
  });
  await page.getByLabel('Search work').fill('iPhone');
  await expect(page.getByText('Build the iPhone app', { exact: true })).toBeVisible();
  await expect(page.getByText('Review release notes', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('tab', { name: 'Needs you', exact: true }).click();
  await expect(page.getByText('Review release notes', { exact: true })).toBeVisible();
  await expect(page.getByText('Build the iPhone app', { exact: true })).toHaveCount(0);
});
