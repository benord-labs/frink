import type { Page } from '@playwright/test';

export const fixtureHost = 'https://mobile-fixture.example.test';

export async function mockCompanion(page: Page, overrides: Record<string, unknown> = {}) {
  const chat = { id: 'chat-1', name: 'Prepare the next release', projectId: 'project-1' };
  const data: Record<string, unknown> = {
    overview: {
      machineName: 'Studio Mac',
      executionReady: true,
      queue: [],
      questions: [],
      permissions: [],
    },
    projects: [{ id: 'project-1', name: 'Frink' }],
    chats: [chat],
    chat: {
      chat,
      subChatId: 'sub-1',
      subChats: [{ id: 'sub-1', name: 'Release' }],
      messages: [{ id: 'm1', role: 'assistant', text: 'Ready when you are.' }],
      hasMore: false,
      active: false,
      error: null,
      questions: [],
      permissions: [],
    },
    flows: [],
    ...overrides,
  };
  const requests: Array<Record<string, unknown>> = [];
  const state = { offline: false, data, requests };
  await page.route(`${fixtureHost}/**`, async (route) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type,authorization',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (route.request().url().endsWith('/pair'))
      return route.fulfill({
        headers,
        json: {
          token: 'b'.repeat(43),
          deviceId: 'device-1',
          machineName: 'Studio Mac',
          apiVersion: 1,
        },
      });
    const input = route.request().postDataJSON();
    requests.push(input);
    if (state.offline) return route.abort('connectionreset');
    return route.fulfill({ headers, json: { data: data[input.type] ?? { ok: true } } });
  });
  await page.goto('/');
  await page
    .getByRole('textbox', { name: 'Pairing code', exact: true })
    .fill(JSON.stringify({ version: 1, url: fixtureHost, code: 'a'.repeat(43) }));
  await page.getByRole('button', { name: 'Connect to Frink', exact: true }).click();
  return state;
}
