import type { Page, Request } from '@playwright/test';
import type { MobileResponses } from '@frink/shared/types/remote/mobile';
import { NOW, previewData } from './data';

export const fixtureHost = 'https://mobile-fixture.example.test';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'content-type,authorization,x-frink-chat,x-frink-sub-chat,x-frink-filename',
};

type Input = Record<string, unknown> & { type: keyof MobileResponses };
export type AppState = {
  offline: boolean;
  data: Partial<Record<keyof MobileResponses, unknown>>;
  requests: Input[];
  /** This iPhone's alert registration on the Mac, and every registration request it received. */
  notifications: { enabled: boolean; error: string | null };
  alerts: { token?: string | null }[];
  /** Answer one request yourself: return a value to send it, undefined for the default. */
  respond?: (input: Input) => unknown;
};

/** Records a raw attachment upload and answers as the computer would. */
function recordUpload(request: Request, requests: Input[]) {
  const name = decodeURIComponent(request.headers()['x-frink-filename'] ?? 'file');
  const contentType = request.headers()['content-type'];
  requests.push({ type: 'upload' as keyof MobileResponses, name, contentType });
  const kind = contentType?.startsWith('image/') ? 'image' : 'file';
  return { id: `att-${requests.length}`, kind, name, size: 4 };
}

type ComposerLike = { mode: string; settings: Record<string, unknown> };
/** The computer saves a composer change and answers with the whole composer, as the bridge does. */
function applyComposerChange(composer: ComposerLike, input: Input) {
  if (input.type === 'updateComposer')
    composer.settings = { ...composer.settings, ...(input.patch as object) };
  else if (input.type === 'setMode') composer.mode = String(input.mode);
  else if (input.type !== 'setAccount') return undefined;
  return composer;
}

/**
 * Draws an iPhone's status bar, Dynamic Island and home indicator over the preview, so
 * screenshots show what the app's safe areas are for. Pointer-transparent; tests never see it.
 */
function drawDeviceChrome() {
  const install = () => {
    const chrome = document.createElement('div');
    chrome.setAttribute('aria-hidden', 'true');
    chrome.innerHTML = `
      <style>
        #device-chrome { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
          font: 600 17px -apple-system, system-ui, sans-serif; color: #fff; }
        @media (prefers-color-scheme: light) { #device-chrome { color: #000; } }
        #device-chrome .time { position: absolute; top: 18px; left: 0; width: 132px; text-align: center; }
        #device-chrome .island { position: absolute; top: 11px; left: 50%; width: 126px; height: 37px;
          margin-left: -63px; border-radius: 19px; background: #000; }
        #device-chrome .icons { position: absolute; top: 21px; right: 30px; display: flex; gap: 6px; align-items: flex-end; }
        #device-chrome .bars { display: flex; gap: 2px; align-items: flex-end; }
        #device-chrome .bars i { width: 3px; background: currentColor; border-radius: 1px; }
        #device-chrome .battery { width: 25px; height: 12px; border: 1px solid currentColor; border-radius: 4px;
          padding: 1px; opacity: .9; }
        #device-chrome .battery i { display: block; height: 100%; width: 80%; background: currentColor; border-radius: 2px; }
        #device-chrome .home { position: absolute; bottom: 8px; left: 50%; width: 134px; height: 5px;
          margin-left: -67px; border-radius: 3px; background: currentColor; }
      </style>
      <div id="device-chrome"><span class="time">9:41</span><span class="island"></span>
        <span class="icons"><span class="bars"><i style="height:4px"></i><i style="height:6px"></i><i style="height:8px"></i><i style="height:10px"></i></span>
        <span class="battery"><i></i></span></span><span class="home"></span></div>`;
    document.body.appendChild(chrome);
  };
  if (document.body) install();
  else document.addEventListener('DOMContentLoaded', install);
}

/**
 * Opens the app against a mocked computer. `paired` (default) skips onboarding by seeding this
 * tab's pairing; `path` opens it from a link; the clock is frozen at NOW so relative times are stable.
 */
export async function openApp(
  page: Page,
  {
    data = {},
    paired = true,
    path = '/',
    respond,
    notifications = { enabled: false, error: null },
  }: {
    data?: AppState['data'];
    paired?: boolean;
    path?: string;
    respond?: AppState['respond'];
    notifications?: AppState['notifications'];
  } = {},
): Promise<AppState> {
  const state: AppState = {
    offline: false,
    data: { ...previewData(), ...data },
    requests: [],
    notifications,
    alerts: [],
    respond,
  };
  await page.clock.install({ time: NOW });
  await page.addInitScript(drawDeviceChrome);
  if (paired)
    await page.addInitScript((url) => {
      sessionStorage.setItem(
        'frink.mobile.connection',
        JSON.stringify({ url, token: 'b'.repeat(43), deviceId: 'device-1', machineName: "Benji's MacBook Pro" }),
      );
    }, `${fixtureHost}/`);
  await page.route(`${fixtureHost}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (state.offline) return route.abort('connectionreset');
    if (request.url().endsWith('/pair'))
      return route.fulfill({
        headers,
        json: { token: 'b'.repeat(43), deviceId: 'device-1', machineName: "Benji's MacBook Pro", apiVersion: 2 },
      });
    if (request.url().endsWith('/api/attachments'))
      return route.fulfill({ headers, json: { data: recordUpload(request, state.requests) } });
    if (request.url().endsWith('/api/notifications')) {
      const alert = request.postDataJSON() as { token?: string | null };
      state.alerts.push(alert);
      if (alert.token !== undefined) state.notifications = { enabled: !!alert.token, error: null };
      return route.fulfill({ headers, json: { data: state.notifications } });
    }
    const input = request.postDataJSON() as Input;
    state.requests.push(input);
    const custom = state.respond?.(input);
    if (custom instanceof Error)
      return route.fulfill({ status: 409, headers, json: { error: custom.message } });
    if (custom !== undefined) return route.fulfill({ headers, json: { data: custom } });
    const saved = applyComposerChange(state.data.composer as ComposerLike, input);
    if (saved) return route.fulfill({ headers, json: { data: saved } });
    return route.fulfill({ headers, json: { data: state.data[input.type] ?? { ok: true } } });
  });
  await page.goto(path);
  return state;
}

export const pairingCode = () =>
  JSON.stringify({ version: 2, url: fixtureHost, code: 'a'.repeat(43) });
/** The web preview's stand-in for opening frink-mobile://pair?… from the Camera. */
export const pairingLinkPath = (url = fixtureHost) =>
  `/pair?${new URLSearchParams({ url, code: 'a'.repeat(43), v: '2' })}`;
