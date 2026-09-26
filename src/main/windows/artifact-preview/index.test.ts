import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ArtifactPreviewOpenRequest } from '../../../shared/types/artifacts/html-artifact';
import {
  type ArtifactPreviewDependencies,
  type ArtifactPreviewHost,
  type ArtifactPreviewIpcEvent,
  ArtifactPreviewManager,
  type ArtifactPreviewSender,
} from './index';

const CLOSED_CHANNEL = 'artifact-preview:closed';
const FOCUS_RETURNED_CHANNEL = 'artifact-preview:focus-returned';
const BOUNDS = { x: 10, y: 20, width: 500, height: 400 };
function request(surfaceId = 'pane:0'): ArtifactPreviewOpenRequest {
  const bodyHtml = '<main id="artifact"><button>Filter messages</button></main>';
  return {
    surfaceId,
    bounds: BOUNDS,
    artifact: {
      version: 1,
      artifactId: 'run:node',
      title: 'Customer digest <18 & 22 Aug>',
      bodyHtml,
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type RequestPolicyHandler = (
  details: { url: string },
  callback: (result: { cancel: boolean }) => void,
) => void;
type RequestPolicy = { handler?: RequestPolicyHandler };
type TestGuest = {
  close: Mock;
  events: EventEmitter;
  focus: Mock;
  isDestroyed: Mock;
  loadURL: Mock;
  on: EventEmitter['on'];
  setAudioMuted: Mock;
  setWindowOpenHandler: Mock;
};
type TestView = {
  attachTo: Mock;
  removeFrom: Mock;
  setBounds: Mock;
  webContents: TestGuest;
};

function harness() {
  const requestPolicy: RequestPolicy = {};
  const sessionEvents = new EventEmitter();
  const senderEvents = new EventEmitter();
  const windowEvents = new EventEmitter();
  const loadQueue: Promise<void>[] = [];
  const guests: Array<{
    guest: TestGuest;
    view: TestView;
  }> = [];

  const previewSession = {
    enableNetworkEmulation: vi.fn(),
    webRequest: {
      onBeforeRequest: vi.fn((_filter, handler) => {
        requestPolicy.handler = handler;
      }),
    },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    on: vi.fn(sessionEvents.on.bind(sessionEvents)),
  };
  const contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
  const mainFrame = { routingId: 1 };
  const sender = {
    id: 11,
    mainFrame,
    focus: vi.fn(),
    getZoomFactor: vi.fn(() => 0.925),
    isDestroyed: vi.fn(() => false),
    on: senderEvents.on.bind(senderEvents),
    send: vi.fn(),
  };
  const host = {
    id: 7,
    contentView,
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    on: windowEvents.on.bind(windowEvents),
    webContents: sender,
  };
  let expectedHost: ArtifactPreviewHost | null = host;
  let senderHost: ArtifactPreviewHost | null = host;

  const createView = vi.fn(() => {
    const events = new EventEmitter();
    const guest = {
      events,
      loadURL: vi.fn(() => loadQueue.shift() ?? Promise.resolve()),
      focus: vi.fn(),
      on: events.on.bind(events),
      setWindowOpenHandler: vi.fn(),
      setAudioMuted: vi.fn(),
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    };
    const view = {
      attachTo: vi.fn(),
      removeFrom: vi.fn(),
      webContents: guest,
      setBounds: vi.fn(),
    };
    guests.push({ guest, view });
    return view;
  });
  const deps: ArtifactPreviewDependencies = {
    createView,
    fromSender: vi.fn(() => senderHost),
    getExpectedHost: vi.fn(() => expectedHost),
    sessionFromPartition: vi.fn(() => previewSession),
  };
  const manager = new ArtifactPreviewManager(deps);

  return {
    contentView,
    deps,
    event: (
      eventSender: ArtifactPreviewSender = sender,
      senderFrame: ArtifactPreviewIpcEvent['senderFrame'] = eventSender.mainFrame,
    ): ArtifactPreviewIpcEvent => ({ sender: eventSender, senderFrame }),
    guests,
    host,
    loadNext: (promise: Promise<void>) => loadQueue.push(promise),
    manager,
    previewSession,
    requestPolicy,
    sender,
    senderEvents,
    sessionEvents,
    setExpectedHost: (value: ArtifactPreviewHost | null) => {
      expectedHost = value;
    },
    setSenderHost: (value: ArtifactPreviewHost | null) => {
      senderHost = value;
    },
    windowEvents,
  };
}

describe('ArtifactPreviewManager', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reuses one nonpersistent offline session with no privileged guest capabilities', async () => {
    const h = harness();
    await h.manager.open(h.event(), request());
    await h.manager.open(h.event(), request());

    expect(h.deps.sessionFromPartition).toHaveBeenCalledWith('artifact-preview', { cache: false });
    expect(h.deps.createView).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({
        partition: 'artifact-preview',
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
        webviewTag: false,
        plugins: false,
        navigateOnDragDrop: false,
        focusOnNavigation: false,
        disableDialogs: true,
        autoplayPolicy: 'document-user-activation-required',
      }),
    });
    expect(h.previewSession.enableNetworkEmulation).toHaveBeenCalledWith({ offline: true });
    expect(h.previewSession.webRequest.onBeforeRequest).toHaveBeenCalledOnce();
    expect(h.previewSession.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(h.previewSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(h.previewSession.setDisplayMediaRequestHandler).toHaveBeenCalledOnce();
    expect(h.previewSession.on).toHaveBeenCalledOnce();
    expect(h.guests[0]?.guest.setAudioMuted).toHaveBeenCalledWith(true);
    expect(h.guests[0]?.guest.setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(h.guests[0]?.guest.focus).not.toHaveBeenCalled();
  });

  it('focuses the sandbox only after an explicit trusted-renderer request', async () => {
    const h = harness();
    await h.manager.open(h.event(), request());

    expect(h.guests[0]?.guest.focus).not.toHaveBeenCalled();
    h.manager.focus(h.event(), { surfaceId: 'pane:0' });
    expect(h.guests[0]?.guest.focus).toHaveBeenCalledOnce();
  });

  it('denies network, permissions, display capture, downloads, navigation, and popups', async () => {
    const h = harness();
    await h.manager.open(h.event(), request());

    const blocked = vi.fn();
    h.requestPolicy.handler?.({ url: 'https://example.com/steal' }, blocked);
    expect(blocked).toHaveBeenCalledWith({ cancel: true });
    const malformed = vi.fn();
    h.requestPolicy.handler?.({ url: 'not a url' }, malformed);
    expect(malformed).toHaveBeenCalledWith({ cancel: true });
    const local = vi.fn();
    h.requestPolicy.handler?.({ url: 'data:image/png;base64,AA==' }, local);
    expect(local).toHaveBeenCalledWith({ cancel: false });

    const permission = vi.fn();
    h.previewSession.setPermissionRequestHandler.mock.calls[0]?.[0]({}, 'camera', permission);
    expect(permission).toHaveBeenCalledWith(false);
    expect(h.previewSession.setPermissionCheckHandler.mock.calls[0]?.[0]()).toBe(false);
    const displayMedia = vi.fn();
    h.previewSession.setDisplayMediaRequestHandler.mock.calls[0]?.[0]({}, displayMedia);
    expect(displayMedia).toHaveBeenCalledWith({});

    const downloadEvent = { preventDefault: vi.fn() };
    const downloadItem = { cancel: vi.fn() };
    h.sessionEvents.emit('will-download', downloadEvent, downloadItem);
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
    expect(downloadItem.cancel).toHaveBeenCalledOnce();

    const navEvent = { preventDefault: vi.fn() };
    h.guests[0]?.guest.events.emit('will-navigate', navEvent);
    h.guests[0]?.guest.events.emit('will-frame-navigate', navEvent);
    h.guests[0]?.guest.events.emit('will-redirect', navEvent);
    expect(navEvent.preventDefault).toHaveBeenCalledTimes(3);
    const openHandler = h.guests[0]?.guest.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(openHandler()).toEqual({ action: 'deny' });
  });

  it('loads body HTML only after a trusted lockdown script and restrictive CSP', async () => {
    const h = harness();
    await h.manager.open(h.event(), request());

    const dataUrl = h.guests[0]?.guest.loadURL.mock.calls[0]?.[0];
    if (!dataUrl) throw new Error('Expected the preview guest to load a data URL');
    expect(dataUrl).toMatch(/^data:text\/html;charset=utf-8,/);
    const document = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1));
    expect(document).toContain("worker-src 'none'");
    expect(document).toContain("webrtc 'block'");
    expect(document).toContain("media-src 'none'");
    expect(document).toContain('RTCPeerConnection');
    expect(document).toContain('webkitRTCPeerConnection');
    expect(document).toContain('mozRTCPeerConnection');
    expect(document).toContain('localStorage');
    expect(document).toContain('sessionStorage');
    expect(document).toContain('indexedDB');
    expect(document).toContain('serviceWorker');
    expect(document.indexOf('RTCPeerConnection')).toBeLessThan(document.indexOf('id="artifact"'));
    expect(document).toContain('<title>Customer digest &lt;18 &amp; 22 Aug&gt;</title>');
  });

  it('rejects subframes, destroyed senders, unexpected windows, and sender lookalikes', async () => {
    const h = harness();
    await expect(h.manager.open(h.event(h.sender, null), request())).rejects.toThrow(
      /main renderer frame/i,
    );
    await expect(h.manager.open(h.event(h.sender, {}), request())).rejects.toThrow(
      /main renderer frame/i,
    );

    h.sender.isDestroyed.mockReturnValueOnce(true);
    await expect(h.manager.open(h.event(), request())).rejects.toThrow(/main renderer frame/i);

    h.setExpectedHost(null);
    await expect(h.manager.open(h.event(), request())).rejects.toThrow(/unavailable/i);
    h.setExpectedHost(h.host);
    h.setSenderHost(null);
    await expect(h.manager.open(h.event(), request())).rejects.toThrow(/unavailable/i);
    h.setSenderHost(h.host);

    const lookalike = {
      ...h.sender,
      mainFrame: { routingId: 2 },
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      send: vi.fn(),
    };
    await expect(h.manager.open(h.event(lookalike), request())).rejects.toThrow(/unavailable/i);
  });

  it('rejects malformed open requests before creating a native guest', async () => {
    const h = harness();

    await expect(h.manager.open(h.event(), { ...request(), artifact: null })).rejects.toThrow(
      'Invalid artifact preview',
    );
    expect(h.deps.createView).not.toHaveBeenCalled();
  });

  it('reports current host activity only to the trusted main renderer frame', () => {
    const h = harness();
    expect(h.manager.isHostFocused(h.event())).toBe(true);

    h.host.isFocused.mockReturnValueOnce(false);
    expect(h.manager.isHostFocused(h.event())).toBe(false);
    expect(() => h.manager.isHostFocused(h.event(h.sender, {}))).toThrow(/main renderer frame/i);
  });

  it('rejects an inactive host before attaching and destroys the untrusted guest', async () => {
    const h = harness();
    h.host.isVisible.mockReturnValue(false);

    await expect(h.manager.open(h.event(), request())).rejects.toThrow(/inactive/i);
    expect(h.contentView.addChildView).not.toHaveBeenCalled();
    expect(h.guests[0]?.guest.close).toHaveBeenCalledOnce();

    h.host.isVisible.mockReturnValue(true);
    await expect(h.manager.open(h.event(), request())).resolves.toBeUndefined();
  });

  it('uses object ownership rather than a reusable webContents id', async () => {
    const h = harness();
    await h.manager.open(h.event(), request());
    const lookalike = {
      ...h.sender,
      mainFrame: { routingId: 2 },
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      send: vi.fn(),
    };

    expect(() =>
      h.manager.updateBounds(h.event(lookalike), {
        surfaceId: 'pane:0',
        bounds: BOUNDS,
      }),
    ).toThrow(/unavailable/i);
  });

  it('clamps scaled renderer bounds to the current host content area', async () => {
    const h = harness();
    await h.manager.open(h.event(), request());
    expect(h.guests[0]?.view.setBounds).toHaveBeenCalledWith({
      x: 9,
      y: 19,
      width: 463,
      height: 370,
    });

    h.manager.updateBounds(h.event(), {
      surfaceId: 'pane:0',
      bounds: { x: 99_999, y: 99_999, width: 50, height: 50 },
    });
    expect(h.guests[0]?.view.setBounds).toHaveBeenLastCalledWith({
      x: 1199,
      y: 799,
      width: 1,
      height: 1,
    });
  });

  it('treats close as idempotent across renderer and native teardown races', async () => {
    const h = harness();
    await h.manager.open(h.event(), request());

    h.manager.close(h.event(), { surfaceId: 'pane:0' });
    expect(() => h.manager.close(h.event(), { surfaceId: 'pane:0' })).not.toThrow();
    expect(h.guests[0]?.guest.close).toHaveBeenCalledOnce();
  });

  it('returns guest Escape to the owning renderer without destroying the sandbox', async () => {
    const h = harness();
    await h.manager.open(h.event(), request());
    const ignoredEvent = { preventDefault: vi.fn() };
    h.guests[0]?.guest.events.emit('before-input-event', ignoredEvent, {
      type: 'keyDown',
      key: 'Enter',
    });
    expect(ignoredEvent.preventDefault).not.toHaveBeenCalled();

    const escapeEvent = { preventDefault: vi.fn() };
    h.guests[0]?.guest.events.emit('before-input-event', escapeEvent, {
      type: 'keyDown',
      key: 'Escape',
    });

    expect(escapeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(h.guests[0]?.guest.close).not.toHaveBeenCalled();
    expect(h.sender.focus).toHaveBeenCalledOnce();
    expect(h.sender.send).toHaveBeenCalledOnce();
    expect(h.sender.send).toHaveBeenCalledWith(FOCUS_RETURNED_CHANNEL, {
      surfaceId: 'pane:0',
    });
  });

  it.each(['blur', 'hide', 'minimize'] as const)(
    'suspends and notifies the renderer when the host emits %s',
    async (eventName) => {
      const h = harness();
      await h.manager.open(h.event(), request());

      h.windowEvents.emit(eventName);
      h.windowEvents.emit(eventName);

      expect(h.guests[0]?.guest.close).toHaveBeenCalledOnce();
      expect(h.sender.send).toHaveBeenCalledOnce();
      expect(h.sender.send).toHaveBeenCalledWith(CLOSED_CHANNEL, {
        surfaceId: 'pane:0',
        reason: 'suspended',
      });
    },
  );

  it('does not resurrect a guest suspended during its asynchronous load', async () => {
    const h = harness();
    const pendingLoad = deferred();
    h.loadNext(pendingLoad.promise);
    const openResult = h.manager.open(h.event(), request());

    h.windowEvents.emit('blur');
    pendingLoad.resolve();
    await expect(openResult).resolves.toBeUndefined();

    expect(h.guests[0]?.guest.close).toHaveBeenCalledOnce();
    expect(h.sender.send).toHaveBeenCalledWith(CLOSED_CHANNEL, {
      surfaceId: 'pane:0',
      reason: 'suspended',
    });
  });

  it('keeps a replacement alive when a stale load fails', async () => {
    const h = harness();
    const staleLoad = deferred();
    h.loadNext(staleLoad.promise);
    const firstResult = h.manager.open(h.event(), request()).then(
      () => ({ ok: true as const }),
      (error: Error) => ({ error, ok: false as const }),
    );

    await h.manager.open(h.event(), request());
    staleLoad.reject(new Error('stale load failed'));

    expect(await firstResult).toEqual({ ok: true });
    expect(h.guests[0]?.guest.close).toHaveBeenCalledOnce();
    expect(h.guests[1]?.guest.close).not.toHaveBeenCalled();
  });

  it('tears down a current guest after asynchronous or synchronous setup failure', async () => {
    const h = harness();
    h.loadNext(Promise.reject(new Error('load failed')));
    await expect(h.manager.open(h.event(), request())).rejects.toThrow('load failed');
    expect(h.guests[0]?.guest.close).toHaveBeenCalledOnce();

    h.contentView.addChildView.mockImplementationOnce(() => {
      throw new Error('attach failed');
    });
    await expect(h.manager.open(h.event(), request())).rejects.toThrow('attach failed');
    expect(h.guests[1]?.guest.close).toHaveBeenCalledOnce();

    await expect(h.manager.open(h.event(), request())).resolves.toBeUndefined();
    expect(h.guests[2]?.guest.close).not.toHaveBeenCalled();
  });

  it('destroys only current surfaces on renderer navigation, host close, and guest crashes', async () => {
    const h = harness();
    await h.manager.open(h.event(), request());
    h.senderEvents.emit('did-start-navigation', {}, '', false, false);
    expect(h.guests[0]?.guest.close).not.toHaveBeenCalled();
    h.senderEvents.emit('did-start-navigation', {}, '', false, true);
    expect(h.guests[0]?.guest.close).toHaveBeenCalledOnce();

    await h.manager.open(h.event(), request());
    const staleGuestEvents = h.guests[1]?.guest.events;
    await h.manager.open(h.event(), request());
    staleGuestEvents?.emit('render-process-gone');
    expect(h.guests[2]?.guest.close).not.toHaveBeenCalled();
    h.guests[2]?.guest.events.emit('unresponsive');
    expect(h.guests[2]?.guest.close).toHaveBeenCalledOnce();
    expect(h.sender.send).toHaveBeenCalledWith(CLOSED_CHANNEL, {
      surfaceId: 'pane:0',
      reason: 'failed',
    });

    await h.manager.open(h.event(), request());
    h.windowEvents.emit('closed');
    expect(h.guests[3]?.guest.close).toHaveBeenCalledOnce();
  });
});
