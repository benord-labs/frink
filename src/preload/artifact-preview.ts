import { ipcRenderer } from 'electron';
import {
  isArtifactPreviewBoundsRequest,
  isArtifactPreviewClosedEvent,
  isArtifactPreviewCloseRequest,
  isArtifactPreviewFocusReturnedEvent,
  isArtifactPreviewOpenRequest,
} from '../shared/lib/artifacts/html-artifact';
import {
  ARTIFACT_PREVIEW_CHANNELS,
  type ArtifactPreviewBoundsRequest,
  type ArtifactPreviewClosedEvent,
  type ArtifactPreviewCloseRequest,
  type ArtifactPreviewFocusReturnedEvent,
  type ArtifactPreviewOpenRequest,
} from '../shared/types/artifacts/html-artifact';

export type ArtifactPreviewApi = {
  open: (request: ArtifactPreviewOpenRequest) => Promise<void>;
  focus: (request: ArtifactPreviewCloseRequest) => Promise<void>;
  updateBounds: (request: ArtifactPreviewBoundsRequest) => Promise<void>;
  close: (request: ArtifactPreviewCloseRequest) => Promise<void>;
  isHostFocused: () => Promise<boolean>;
  onClosed: (callback: (event: ArtifactPreviewClosedEvent) => void) => () => void;
  onFocusReturned: (callback: (event: ArtifactPreviewFocusReturnedEvent) => void) => () => void;
};

type ArtifactPreviewClosedCallback = (event: ArtifactPreviewClosedEvent) => void;
type ArtifactPreviewClosedPayload =
  | ArtifactPreviewClosedEvent
  | Partial<Record<keyof ArtifactPreviewClosedEvent, string>>
  | null;
type ArtifactPreviewFocusReturnedPayload =
  | ArtifactPreviewFocusReturnedEvent
  | Partial<Record<keyof ArtifactPreviewFocusReturnedEvent, string>>
  | null;

export type ArtifactPreviewTransport = {
  open: (request: ArtifactPreviewOpenRequest) => Promise<void>;
  focus: (request: ArtifactPreviewCloseRequest) => Promise<void>;
  updateBounds: (request: ArtifactPreviewBoundsRequest) => Promise<void>;
  close: (request: ArtifactPreviewCloseRequest) => Promise<void>;
  isHostFocused: () => Promise<boolean>;
  onClosed: (callback: (event: ArtifactPreviewClosedPayload) => void) => () => void;
  onFocusReturned: (callback: (event: ArtifactPreviewFocusReturnedPayload) => void) => () => void;
};

export type ArtifactPreviewIpcRenderer = Pick<
  Electron.IpcRenderer,
  'invoke' | 'on' | 'removeListener'
>;

export function createArtifactPreviewTransport(
  renderer: ArtifactPreviewIpcRenderer,
): ArtifactPreviewTransport {
  return {
    open: (request) => renderer.invoke(ARTIFACT_PREVIEW_CHANNELS.open, request),
    focus: (request) => renderer.invoke(ARTIFACT_PREVIEW_CHANNELS.focus, request),
    updateBounds: (request) => renderer.invoke(ARTIFACT_PREVIEW_CHANNELS.updateBounds, request),
    close: (request) => renderer.invoke(ARTIFACT_PREVIEW_CHANNELS.close, request),
    isHostFocused: () => renderer.invoke(ARTIFACT_PREVIEW_CHANNELS.isHostFocused),
    onClosed: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        value: ArtifactPreviewClosedPayload,
      ): void => callback(value);
      renderer.on(ARTIFACT_PREVIEW_CHANNELS.closed, handler);
      return () => renderer.removeListener(ARTIFACT_PREVIEW_CHANNELS.closed, handler);
    },
    onFocusReturned: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        value: ArtifactPreviewFocusReturnedPayload,
      ): void => callback(value);
      renderer.on(ARTIFACT_PREVIEW_CHANNELS.focusReturned, handler);
      return () => renderer.removeListener(ARTIFACT_PREVIEW_CHANNELS.focusReturned, handler);
    },
  };
}

export function createArtifactPreviewApi(transport: ArtifactPreviewTransport) {
  return {
    open: (request) => {
      if (!isArtifactPreviewOpenRequest(request)) throw new TypeError('Invalid artifact preview');
      return transport.open(request);
    },
    focus: (request) => {
      if (!isArtifactPreviewCloseRequest(request)) throw new TypeError('Invalid preview focus');
      return transport.focus(request);
    },
    updateBounds: (request) => {
      if (!isArtifactPreviewBoundsRequest(request)) throw new TypeError('Invalid preview bounds');
      return transport.updateBounds(request);
    },
    close: (request) => {
      if (!isArtifactPreviewCloseRequest(request)) throw new TypeError('Invalid preview close');
      return transport.close(request);
    },
    isHostFocused: () => transport.isHostFocused(),
    onClosed: (callback: ArtifactPreviewClosedCallback | null) => {
      if (!callback) throw new TypeError('Invalid artifact preview callback');
      return transport.onClosed((value) => {
        if (isArtifactPreviewClosedEvent(value)) callback(value);
      });
    },
    onFocusReturned: (callback: ((event: ArtifactPreviewFocusReturnedEvent) => void) | null) => {
      if (!callback) throw new TypeError('Invalid artifact focus callback');
      return transport.onFocusReturned((value) => {
        if (isArtifactPreviewFocusReturnedEvent(value)) callback(value);
      });
    },
  } satisfies ArtifactPreviewApi;
}

export const artifactPreviewApi: ArtifactPreviewApi = createArtifactPreviewApi(
  createArtifactPreviewTransport(ipcRenderer),
);
