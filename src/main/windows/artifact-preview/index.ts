import type { EventEmitter } from 'node:events';
import {
  BrowserWindow,
  ipcMain,
  type Session,
  session,
  type WebContents,
  WebContentsView,
} from 'electron';
import { LAUNCH_FLAGS } from '../../../shared/launch-flags';
import {
  isArtifactPreviewBoundsRequest,
  isArtifactPreviewCloseRequest,
  isArtifactPreviewOpenRequest,
} from '../../../shared/lib/artifacts/html-artifact';
import {
  ARTIFACT_PREVIEW_CHANNELS,
  type ArtifactPreviewBounds,
  type ArtifactPreviewClosedEvent,
  type ArtifactPreviewOpenRequest,
} from '../../../shared/types/artifacts/html-artifact';
import { artifactDataUrl } from './artifact-document';

const ARTIFACT_PREVIEW_PARTITION = 'artifact-preview';

type ArtifactPreviewPrimitive = boolean | null | number | string;
type ArtifactPreviewPayload =
  | ArtifactPreviewPrimitive
  | readonly ArtifactPreviewPayload[]
  | { readonly [key: string]: ArtifactPreviewPayload };
type Listenable = { on: EventEmitter['on'] };
type PreviewGuest = Pick<
  WebContents,
  'close' | 'focus' | 'isDestroyed' | 'loadURL' | 'setAudioMuted' | 'setWindowOpenHandler'
> &
  Listenable;
type ArtifactPreviewView = {
  attachTo: (host: BrowserWindow) => void;
  removeFrom: (host: BrowserWindow) => void;
  setBounds: WebContentsView['setBounds'];
  webContents: PreviewGuest;
};
export type ArtifactPreviewSender = Pick<
  WebContents,
  'focus' | 'getZoomFactor' | 'id' | 'isDestroyed' | 'send'
> &
  Listenable & { mainFrame: object };
type ArtifactPreviewContentView = {
  addChildView: (view: ArtifactPreviewView) => void;
  removeChildView: (view: ArtifactPreviewView) => void;
};
export type ArtifactPreviewHost = Pick<
  BrowserWindow,
  'getContentBounds' | 'id' | 'isDestroyed' | 'isFocused' | 'isMinimized' | 'isVisible'
> & {
  contentView: ArtifactPreviewContentView;
  webContents: ArtifactPreviewSender;
} & Listenable;

export type ArtifactPreviewIpcEvent = { sender: ArtifactPreviewSender; senderFrame: object | null };

type ArtifactPreviewSession = Pick<
  Session,
  | 'enableNetworkEmulation'
  | 'setDisplayMediaRequestHandler'
  | 'setPermissionCheckHandler'
  | 'setPermissionRequestHandler'
> &
  Listenable & {
    webRequest: {
      onBeforeRequest: (
        filter: { urls: string[] },
        listener: (
          details: { url: string },
          callback: (response: { cancel: boolean }) => void,
        ) => void,
      ) => void;
    };
  };
type PartitionOptions = Electron.FromPartitionOptions;

export type ArtifactPreviewDependencies = {
  createView: (options: Electron.WebContentsViewConstructorOptions) => ArtifactPreviewView;
  fromSender: (sender: ArtifactPreviewSender) => ArtifactPreviewHost | null;
  getExpectedHost: () => ArtifactPreviewHost | null;
  sessionFromPartition: (key: string, options: PartitionOptions) => ArtifactPreviewSession;
};

type Surface = {
  generation: number;
  key: string;
  ownerSender: ArtifactPreviewSender;
  surfaceId: string;
  host: ArtifactPreviewHost;
  view: ArtifactPreviewView;
};
type PreviewOwner = { host: ArtifactPreviewHost; sender: ArtifactPreviewSender };

const defaultDependencies: ArtifactPreviewDependencies = {
  createView: (options) => {
    const view = new WebContentsView(options);
    return {
      attachTo: (host) => host.contentView.addChildView(view),
      removeFrom: (host) => host.contentView.removeChildView(view),
      setBounds: (bounds) => view.setBounds(bounds),
      webContents: view.webContents,
    };
  },
  fromSender: (sender) => {
    const host = BrowserWindow.getAllWindows().find((window) => window.webContents === sender);
    return host ? previewHostFor(host) : null;
  },
  getExpectedHost: () => null,
  sessionFromPartition: (partition, options) => session.fromPartition(partition, options),
};

const previewHosts = new WeakMap<BrowserWindow, ArtifactPreviewHost>();

function previewHostFor(window: BrowserWindow): ArtifactPreviewHost {
  const cached = previewHosts.get(window);
  if (cached) return cached;
  const host: ArtifactPreviewHost = {
    contentView: {
      addChildView: (view) => view.attachTo(window),
      removeChildView: (view) => view.removeFrom(window),
    },
    getContentBounds: () => window.getContentBounds(),
    id: window.id,
    isDestroyed: () => window.isDestroyed(),
    isFocused: () => window.isFocused(),
    isMinimized: () => window.isMinimized(),
    isVisible: () => window.isVisible(),
    on: window.on.bind(window),
    webContents: window.webContents,
  };
  previewHosts.set(window, host);
  return host;
}

const policySessions = new WeakSet<ArtifactPreviewSession>();

function scaledBounds(
  bounds: ArtifactPreviewBounds,
  zoom: number,
  host: ArtifactPreviewHost,
): Electron.Rectangle {
  const content = host.getContentBounds();
  const x = Math.min(Math.max(0, Math.round(bounds.x * zoom)), Math.max(0, content.width - 1));
  const y = Math.min(Math.max(0, Math.round(bounds.y * zoom)), Math.max(0, content.height - 1));
  const width = Math.max(1, Math.min(Math.round(bounds.width * zoom), content.width - x));
  const height = Math.max(1, Math.min(Math.round(bounds.height * zoom), content.height - y));
  return { x, y, width, height };
}

function protocolOf(value: string): string {
  try {
    return new URL(value).protocol;
  } catch {
    return '';
  }
}

function installSessionPolicy(previewSession: ArtifactPreviewSession): void {
  if (policySessions.has(previewSession)) return;

  previewSession.enableNetworkEmulation({ offline: true });
  previewSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>', 'data:*', 'blob:*'] },
    ({ url }, callback) => {
      const protocol = protocolOf(url);
      callback({ cancel: protocol !== 'data:' && protocol !== 'blob:' });
    },
  );
  previewSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  previewSession.on('will-download', (event, item) => {
    event.preventDefault();
    item.cancel();
  });
  policySessions.add(previewSession);
}

function requireOpenRequest(value: ArtifactPreviewPayload): ArtifactPreviewOpenRequest {
  if (!isArtifactPreviewOpenRequest(value)) throw new TypeError('Invalid artifact preview');
  return value;
}

export class ArtifactPreviewManager {
  private readonly surfaces = new Map<string, Surface>();
  private readonly generations = new Map<string, number>();
  private readonly observedSenders = new Set<number>();

  constructor(private readonly deps: ArtifactPreviewDependencies = defaultDependencies) {}

  async open(event: ArtifactPreviewIpcEvent, value: ArtifactPreviewPayload): Promise<void> {
    const { host, sender } = this.trustedOwner(event);
    const request = requireOpenRequest(value);
    const surface = this.createSurface(host, sender, request);
    await this.loadSurface(surface, request);
  }

  private createSurface(
    host: ArtifactPreviewHost,
    sender: ArtifactPreviewSender,
    request: ArtifactPreviewOpenRequest,
  ): Surface {
    const key = this.surfaceKey(sender.id, request.surfaceId);
    const generation = this.nextGeneration(key);
    this.destroySurface(key);

    const previewSession = this.deps.sessionFromPartition(ARTIFACT_PREVIEW_PARTITION, {
      cache: false,
    });
    installSessionPolicy(previewSession);
    const view = this.deps.createView({
      webPreferences: {
        partition: ARTIFACT_PREVIEW_PARTITION,
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
        spellcheck: false,
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    const surface = {
      generation,
      key,
      ownerSender: sender,
      surfaceId: request.surfaceId,
      host,
      view,
    };
    this.surfaces.set(key, surface);
    return surface;
  }

  private async loadSurface(surface: Surface, request: ArtifactPreviewOpenRequest): Promise<void> {
    try {
      this.installGuestPolicy(surface);
      this.attachSurface(surface, request.bounds);
      await surface.view.webContents.loadURL(artifactDataUrl(request));
      this.activateLoadedSurface(surface);
    } catch (error) {
      if (!this.isCurrent(surface)) return;
      this.nextGeneration(surface.key);
      this.destroySurface(surface.key, surface);
      throw error;
    }
  }

  private attachSurface(surface: Surface, bounds: ArtifactPreviewBounds): void {
    const { host, ownerSender, view } = surface;
    this.observeOwner(ownerSender, host);
    if (!this.isCurrent(surface) || ownerSender.isDestroyed() || !this.isHostActive(host)) {
      throw new Error('Artifact preview owner window is inactive');
    }
    host.contentView.addChildView(view);
    view.setBounds(scaledBounds(bounds, ownerSender.getZoomFactor(), host));
  }

  private activateLoadedSurface(surface: Surface): void {
    if (!this.isCurrent(surface)) return;
    if (!this.isHostActive(surface.host)) {
      this.disposeSurface(surface, 'suspended');
      return;
    }
  }

  focus(event: ArtifactPreviewIpcEvent, value: ArtifactPreviewPayload): void {
    const { sender } = this.trustedOwner(event);
    if (!isArtifactPreviewCloseRequest(value)) throw new TypeError('Invalid preview focus');
    const surface = this.ownedSurface(sender, value.surfaceId);
    if (!this.isHostActive(surface.host)) throw new Error('Artifact preview host is inactive');
    surface.view.webContents.focus();
  }

  updateBounds(event: ArtifactPreviewIpcEvent, value: ArtifactPreviewPayload): void {
    const { sender } = this.trustedOwner(event);
    if (!isArtifactPreviewBoundsRequest(value)) throw new TypeError('Invalid preview bounds');
    const surface = this.ownedSurface(sender, value.surfaceId);
    surface.view.setBounds(scaledBounds(value.bounds, sender.getZoomFactor(), surface.host));
  }

  close(event: ArtifactPreviewIpcEvent, value: ArtifactPreviewPayload): void {
    const { sender } = this.trustedOwner(event);
    if (!isArtifactPreviewCloseRequest(value)) throw new TypeError('Invalid preview close');
    const key = this.surfaceKey(sender.id, value.surfaceId);
    const surface = this.surfaces.get(key);
    if (!surface) {
      this.nextGeneration(key);
      return;
    }
    if (surface.ownerSender !== sender) throw new Error('Artifact preview owner mismatch');
    this.nextGeneration(key);
    this.destroySurface(key, surface);
  }

  isHostFocused(event: ArtifactPreviewIpcEvent): boolean {
    return this.isHostActive(this.trustedOwner(event).host);
  }

  private trustedOwner(event: ArtifactPreviewIpcEvent): PreviewOwner {
    const sender = event.sender;
    if (sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame) {
      throw new Error('Artifact preview requires the main renderer frame');
    }

    const expectedHost = this.deps.getExpectedHost();
    const senderHost = this.deps.fromSender(sender);
    if (
      !expectedHost ||
      expectedHost.isDestroyed() ||
      senderHost !== expectedHost ||
      expectedHost.webContents !== sender
    ) {
      throw new Error('Artifact preview owner window is unavailable');
    }
    return { host: expectedHost, sender };
  }

  private installGuestPolicy(surface: Surface): void {
    const guest = surface.view.webContents;
    guest.setAudioMuted(true);
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    const prevent = (event: Electron.Event): void => event.preventDefault();
    guest.on('will-navigate', prevent);
    guest.on('will-frame-navigate', prevent);
    guest.on('will-redirect', prevent);
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || !this.isCurrent(surface)) return;
      event.preventDefault();
      surface.ownerSender.focus();
      surface.ownerSender.send(ARTIFACT_PREVIEW_CHANNELS.focusReturned, {
        surfaceId: surface.surfaceId,
      });
    });
    guest.on('render-process-gone', () => this.disposeSurface(surface, 'failed'));
    guest.on('unresponsive', () => this.disposeSurface(surface, 'failed'));
  }

  private sendClosed(surface: Surface, reason: ArtifactPreviewClosedEvent['reason']): void {
    if (surface.ownerSender.isDestroyed()) return;
    const event: ArtifactPreviewClosedEvent = { surfaceId: surface.surfaceId, reason };
    surface.ownerSender.send(ARTIFACT_PREVIEW_CHANNELS.closed, event);
  }

  private observeOwner(sender: ArtifactPreviewSender, host: ArtifactPreviewHost): void {
    if (this.observedSenders.has(sender.id)) return;
    this.observedSenders.add(sender.id);
    const releaseOwner = (): void => this.destroyOwned(sender.id, true);
    sender.on('destroyed', releaseOwner);
    sender.on('render-process-gone', releaseOwner);
    sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) this.destroyOwned(sender.id, false);
    });
    host.on('closed', releaseOwner);
    const suspendOwner = (): void => this.destroyOwned(sender.id, false, 'suspended');
    host.on('blur', suspendOwner);
    host.on('hide', suspendOwner);
    host.on('minimize', suspendOwner);
  }

  private ownedSurface(sender: ArtifactPreviewSender, surfaceId: string): Surface {
    const surface = this.surfaces.get(this.surfaceKey(sender.id, surfaceId));
    if (!surface || surface.ownerSender !== sender) {
      throw new Error('Artifact preview owner mismatch');
    }
    return surface;
  }

  private destroyOwned(
    senderId: number,
    forgetOwner: boolean,
    reason?: ArtifactPreviewClosedEvent['reason'],
  ): void {
    for (const [key, surface] of this.surfaces) {
      if (surface.ownerSender.id !== senderId) continue;
      this.nextGeneration(key);
      this.destroySurface(key, surface);
      if (reason) this.sendClosed(surface, reason);
    }
    if (forgetOwner) this.observedSenders.delete(senderId);
  }

  private disposeSurface(surface: Surface, reason: ArtifactPreviewClosedEvent['reason']): void {
    if (!this.isCurrent(surface)) return;
    this.nextGeneration(surface.key);
    this.destroySurface(surface.key, surface);
    this.sendClosed(surface, reason);
  }

  private destroySurface(key: string, expectedSurface?: Surface): void {
    const surface = this.surfaces.get(key);
    if (!surface || (expectedSurface && surface !== expectedSurface)) return;
    this.surfaces.delete(key);
    if (!surface.host.isDestroyed()) {
      try {
        surface.host.contentView.removeChildView(surface.view);
      } catch {
        // Host teardown can race guest teardown.
      }
    }
    if (!surface.view.webContents.isDestroyed()) surface.view.webContents.close();
  }

  private isCurrent(surface: Surface): boolean {
    return (
      this.surfaces.get(surface.key) === surface &&
      this.generations.get(surface.key) === surface.generation
    );
  }

  private isHostActive(host: ArtifactPreviewHost): boolean {
    return !host.isDestroyed() && host.isVisible() && !host.isMinimized() && host.isFocused();
  }

  private nextGeneration(key: string): number {
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    return generation;
  }

  private surfaceKey(senderId: number, surfaceId: string): string {
    return `${senderId}:${surfaceId}`;
  }
}

let handlersRegistered = false;

export function registerArtifactPreviewIpc(getExpectedHost: () => BrowserWindow | null): void {
  if (!LAUNCH_FLAGS.flowHtmlArtifacts || handlersRegistered) return;
  handlersRegistered = true;
  const artifactPreviewManager = new ArtifactPreviewManager({
    ...defaultDependencies,
    getExpectedHost: () => {
      const host = getExpectedHost();
      return host ? previewHostFor(host) : null;
    },
  });
  ipcMain.handle(ARTIFACT_PREVIEW_CHANNELS.open, (event, request) =>
    artifactPreviewManager.open(event, request),
  );
  ipcMain.handle(ARTIFACT_PREVIEW_CHANNELS.focus, (event, request) =>
    artifactPreviewManager.focus(event, request),
  );
  ipcMain.handle(ARTIFACT_PREVIEW_CHANNELS.updateBounds, (event, request) =>
    artifactPreviewManager.updateBounds(event, request),
  );
  ipcMain.handle(ARTIFACT_PREVIEW_CHANNELS.close, (event, request) =>
    artifactPreviewManager.close(event, request),
  );
  ipcMain.handle(ARTIFACT_PREVIEW_CHANNELS.isHostFocused, (event) =>
    artifactPreviewManager.isHostFocused(event),
  );
}
