import type { Page, Request } from '@playwright/test';

export const fixtureHost = 'https://mobile-fixture.example.test';

/** What the computer answers for `composer`: a Claude chat on defaults. */
export function composerFixture() {
  return {
    mode: 'agent',
    debugAvailable: true,
    provider: 'claude',
    account: {
      id: 'acc-1',
      label: 'Work',
      type: 'claude-code',
      isAuthenticated: true,
      isProjectOverride: false,
    },
    projectId: 'project-1',
    accounts: [
      { id: 'acc-1', label: 'Work', type: 'claude-code', isDefault: true, isAuthenticated: true },
      {
        id: 'acc-2',
        label: 'Personal',
        type: 'claude-code',
        isDefault: false,
        isAuthenticated: true,
      },
    ],
    models: [
      {
        id: 'sonnet',
        name: 'Sonnet',
        familyId: 'sonnet',
        contextLabel: '200k context',
        effort: 'medium',
        effortDefault: true,
        contextDefault: true,
      },
      {
        id: 'sonnet-high',
        name: 'Sonnet',
        detail: 'High',
        familyId: 'sonnet',
        contextLabel: '200k context',
        effort: 'high',
        contextDefault: true,
      },
      {
        id: 'opus-4.8',
        name: 'Opus',
        version: '4.8',
        familyId: 'opus-4.8',
        contextLabel: '1M context',
        effort: 'high',
        effortDefault: true,
        contextDefault: true,
      },
    ],
    settings: { modelId: 'sonnet', autoMode: true, codexFastMode: false, thinkingEnabled: true },
    autoUnavailableReason: '',
    codexFastCredits: null,
    xhighSupported: true,
  };
}

type FixtureComposer = { mode: string; settings: Record<string, unknown> };

/** The computer saves a composer change and answers with the whole composer, as the bridge does. */
function applyComposerChange(composer: FixtureComposer, input: Record<string, unknown>) {
  if (input.type === 'updateComposer')
    composer.settings = { ...composer.settings, ...(input.patch as object) };
  else if (input.type === 'setMode') composer.mode = String(input.mode);
  else if (input.type !== 'setAccount') return undefined;
  return composer;
}

/** Records a raw attachment upload and answers as the computer would. */
function recordUpload(request: Request, requests: Array<Record<string, unknown>>) {
  const name = decodeURIComponent(request.headers()['x-frink-filename'] ?? 'file');
  const contentType = request.headers()['content-type'];
  requests.push({ type: 'upload', name, contentType });
  const kind = contentType?.startsWith('image/') ? 'image' : 'file';
  return { id: `att-${requests.length}`, kind, name, size: 4 };
}

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
    composer: composerFixture(),
    ...overrides,
  };
  const requests: Array<Record<string, unknown>> = [];
  const state = { offline: false, data, requests };
  await page.route(`${fixtureHost}/**`, async (route) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers':
        'content-type,authorization,x-frink-chat,x-frink-sub-chat,x-frink-filename',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (route.request().url().endsWith('/pair'))
      return route.fulfill({
        headers,
        json: {
          token: 'b'.repeat(43),
          deviceId: 'device-1',
          machineName: 'Studio Mac',
          apiVersion: 2,
        },
      });
    if (route.request().url().endsWith('/api/attachments')) {
      if (state.offline) return route.abort('connectionreset');
      return route.fulfill({ headers, json: { data: recordUpload(route.request(), requests) } });
    }
    const input = route.request().postDataJSON();
    requests.push(input);
    if (state.offline) return route.abort('connectionreset');
    const saved = applyComposerChange(data.composer as FixtureComposer, input);
    if (saved) return route.fulfill({ headers, json: { data: saved } });
    return route.fulfill({ headers, json: { data: data[input.type] ?? { ok: true } } });
  });
  await page.goto('/');
  await page
    .getByRole('textbox', { name: 'Pairing code', exact: true })
    .fill(JSON.stringify({ version: 2, url: fixtureHost, code: 'a'.repeat(43) }));
  await page.getByRole('button', { name: 'Connect to Frink', exact: true }).click();
  return state;
}
