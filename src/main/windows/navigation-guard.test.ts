import { pathToFileURL } from 'node:url';
import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const warnMock = vi.hoisted(() => vi.fn());
vi.mock('electron-log', () => ({ default: { warn: warnMock, info: vi.fn(), error: vi.fn() } }));

import {
  attachMainWindowNavigationGuard,
  isAllowedMainWindowNavigation,
  resolveRendererEntryUrl,
} from './navigation-guard';

const PACKAGED_INDEX =
  '/Applications/Frink.app/Contents/Resources/app.asar/out/renderer/index.html';
const PACKAGED_ENTRY = pathToFileURL(PACKAGED_INDEX).href;
const DEV_ENTRY = 'http://localhost:5173/';

describe('isAllowedMainWindowNavigation — packaged (file://) entry', () => {
  it('blocks a file dropped outside any drop target', () => {
    expect(isAllowedMainWindowNavigation('file:///Users/x/theme.json', PACKAGED_ENTRY)).toBe(false);
  });

  it('allows the entry itself, ignoring hash and query', () => {
    expect(isAllowedMainWindowNavigation(PACKAGED_ENTRY, PACKAGED_ENTRY)).toBe(true);
    expect(isAllowedMainWindowNavigation(`${PACKAGED_ENTRY}#/settings`, PACKAGED_ENTRY)).toBe(true);
    expect(isAllowedMainWindowNavigation(`${PACKAGED_ENTRY}?x=1`, PACKAGED_ENTRY)).toBe(true);
  });

  it("blocks a dropped index.html from another folder (every file:// origin is 'null')", () => {
    expect(
      isAllowedMainWindowNavigation('file:///Users/x/site/out/renderer/index.html', PACKAGED_ENTRY),
    ).toBe(false);
  });

  it('blocks a sibling file inside the renderer directory', () => {
    const sibling = PACKAGED_ENTRY.replace(/index\.html$/, 'assets/logo.svg');
    expect(isAllowedMainWindowNavigation(sibling, PACKAGED_ENTRY)).toBe(false);
  });

  it('blocks a dot-segment path that normalises to a different directory', () => {
    const dotted = PACKAGED_ENTRY.replace('/renderer/index.html', '/main/../../out/x/index.html');
    expect(isAllowedMainWindowNavigation(dotted, PACKAGED_ENTRY)).toBe(false);
  });

  it('allows the entry when Chromium percent-encodes the install path differently', () => {
    const entry = pathToFileURL('/Users/Zoë (work)/Frink Beta/renderer/index.html').href;
    const chromiumStyle = 'file:///Users/Zo%C3%AB%20%28work%29/Frink%20Beta/renderer/index.html';
    expect(isAllowedMainWindowNavigation(chromiumStyle, entry)).toBe(true);
  });

  it('matches Windows drive-letter entries and blocks a UNC path with the same pathname', () => {
    const winEntry = 'file:///C:/Program%20Files/Frink/resources/app.asar/out/renderer/index.html';
    expect(isAllowedMainWindowNavigation(`${winEntry}#/`, winEntry)).toBe(true);
    expect(
      isAllowedMainWindowNavigation(
        'file://fileserver/C:/Program%20Files/Frink/resources/app.asar/out/renderer/index.html',
        winEntry,
      ),
    ).toBe(false);
  });

  it('blocks an http URL even when its path equals the entry path', () => {
    expect(isAllowedMainWindowNavigation(`http://evil.test${PACKAGED_INDEX}`, PACKAGED_ENTRY)).toBe(
      false,
    );
  });

  it('blocks a malformed percent-encoding instead of throwing', () => {
    expect(() =>
      isAllowedMainWindowNavigation('file:///Users/x/%E0%A4%A.json', PACKAGED_ENTRY),
    ).not.toThrow();
    expect(isAllowedMainWindowNavigation('file:///Users/x/%E0%A4%A.json', PACKAGED_ENTRY)).toBe(
      false,
    );
  });
});

describe('isAllowedMainWindowNavigation — dev server entry', () => {
  it('allows any path on the dev origin (Vite full reload)', () => {
    expect(isAllowedMainWindowNavigation('http://localhost:5173/', DEV_ENTRY)).toBe(true);
    expect(isAllowedMainWindowNavigation('http://localhost:5173/any?x=1#y', DEV_ENTRY)).toBe(true);
  });

  it('blocks a dropped file, a dragged-in link, and a different port', () => {
    expect(isAllowedMainWindowNavigation('file:///Users/x/a.png', DEV_ENTRY)).toBe(false);
    expect(isAllowedMainWindowNavigation('https://github.com/org/repo', DEV_ENTRY)).toBe(false);
    expect(isAllowedMainWindowNavigation('http://localhost:5174/', DEV_ENTRY)).toBe(false);
  });
});

describe('isAllowedMainWindowNavigation — non-navigable targets', () => {
  it.each([
    'about:blank',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'blob:file:///2b3c',
    'chrome-error://chromewebdata/',
    'not a url',
    '',
  ])('blocks %j against both entry kinds', (target) => {
    expect(isAllowedMainWindowNavigation(target, PACKAGED_ENTRY)).toBe(false);
    expect(isAllowedMainWindowNavigation(target, DEV_ENTRY)).toBe(false);
  });

  it('blocks everything when the entry itself is unparseable', () => {
    expect(isAllowedMainWindowNavigation(PACKAGED_ENTRY, 'not a url')).toBe(false);
  });
});

describe('resolveRendererEntryUrl', () => {
  it('prefers the dev server URL', () => {
    expect(resolveRendererEntryUrl(DEV_ENTRY, PACKAGED_INDEX)).toBe(DEV_ENTRY);
  });

  it.each([undefined, ''])(
    'falls back to the packaged index for %j, matching main.ts `if (devServerUrl)`',
    (dev) => {
      expect(resolveRendererEntryUrl(dev, PACKAGED_INDEX)).toBe(PACKAGED_ENTRY);
    },
  );

  it('produces an entry the guard accepts for Chromium’s encoding of the same path', () => {
    const entry = resolveRendererEntryUrl(undefined, '/opt/Frink App/renderer/index.html');
    expect(
      isAllowedMainWindowNavigation('file:///opt/Frink%20App/renderer/index.html#/', entry),
    ).toBe(true);
  });
});

type NavigateHandler = (event: { preventDefault: () => void }, url: string) => void;

function fakeWebContents(): { wc: WebContents; handlers: Map<string, NavigateHandler> } {
  const handlers = new Map<string, NavigateHandler>();
  const wc = {
    on: vi.fn((name: string, handler: NavigateHandler) => {
      handlers.set(name, handler);
    }),
  } as unknown as WebContents;
  return { wc, handlers };
}

function navigate(handler: NavigateHandler | undefined, url: string): () => void {
  const preventDefault = vi.fn();
  handler?.({ preventDefault }, url);
  return preventDefault;
}

describe('attachMainWindowNavigationGuard', () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it('registers will-navigate only, leaving iframe (will-frame-navigate) navigation alone', () => {
    const { wc, handlers } = fakeWebContents();
    attachMainWindowNavigationGuard(wc, PACKAGED_ENTRY);
    expect([...handlers.keys()]).toEqual(['will-navigate']);
  });

  it('prevents a stray file drop exactly once and logs only the scheme', () => {
    const { wc, handlers } = fakeWebContents();
    attachMainWindowNavigationGuard(wc, PACKAGED_ENTRY);
    const preventDefault = navigate(handlers.get('will-navigate'), 'file:///Users/zoe/secret.pdf');
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnMock.mock.calls[0])).not.toContain('secret');
    expect(warnMock.mock.calls[0]?.[1]).toEqual({ scheme: 'file:' });
  });

  it('lets the entry navigate without preventing or logging', () => {
    const { wc, handlers } = fakeWebContents();
    attachMainWindowNavigationGuard(wc, DEV_ENTRY);
    const preventDefault = navigate(handlers.get('will-navigate'), 'http://localhost:5173/#/');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('still prevents when the target URL is unparseable', () => {
    const { wc, handlers } = fakeWebContents();
    attachMainWindowNavigationGuard(wc, PACKAGED_ENTRY);
    expect(navigate(handlers.get('will-navigate'), '::::')).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[1]).toEqual({ scheme: 'unparseable' });
  });

  it('keeps each window bound to its own entry', () => {
    const packaged = fakeWebContents();
    const dev = fakeWebContents();
    attachMainWindowNavigationGuard(packaged.wc, PACKAGED_ENTRY);
    attachMainWindowNavigationGuard(dev.wc, DEV_ENTRY);
    expect(navigate(packaged.handlers.get('will-navigate'), DEV_ENTRY)).toHaveBeenCalledTimes(1);
    expect(navigate(dev.handlers.get('will-navigate'), DEV_ENTRY)).not.toHaveBeenCalled();
  });
});
