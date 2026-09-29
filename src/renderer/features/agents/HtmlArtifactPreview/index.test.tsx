// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ArtifactPreviewBoundsRequest,
  ArtifactPreviewClosedEvent,
  ArtifactPreviewCloseRequest,
  ArtifactPreviewFocusReturnedEvent,
  ArtifactPreviewOpenRequest,
  HtmlArtifactData,
} from '../../../../shared/types/artifacts/html-artifact';
import { HtmlArtifactPaneProvider, useHtmlArtifactPane } from '../HtmlArtifactPane';
import { HtmlArtifactPreview } from '.';

const ARTIFACT: HtmlArtifactData = {
  version: 1,
  artifactId: 'message-digest',
  title: 'Customer message digest',
  bodyHtml: '<button>Filter urgent messages</button>',
};
const SURFACE_ID = 'html-artifact:chat:single:message-digest';

function SelectArtifact(): null {
  const { openArtifact } = useHtmlArtifactPane();
  useEffect(() => openArtifact(ARTIFACT), [openArtifact]);
  return null;
}

function PreviewWhenSelected() {
  return useHtmlArtifactPane().selection ? (
    <HtmlArtifactPreview />
  ) : (
    <div data-testid="artifact-closed" />
  );
}

function renderPreview() {
  return render(
    <div data-chat-container data-testid="chat-container">
      <HtmlArtifactPaneProvider paneKey="chat:single" isPaneActive>
        <SelectArtifact />
        <PreviewWhenSelected />
      </HtmlArtifactPaneProvider>
    </div>,
  );
}

describe('HtmlArtifactPreview', () => {
  const open = vi.fn<(request: ArtifactPreviewOpenRequest) => Promise<void>>(async () => undefined);
  const updateBounds = vi.fn<(request: ArtifactPreviewBoundsRequest) => Promise<void>>(
    async () => undefined,
  );
  const close = vi.fn<(request: ArtifactPreviewCloseRequest) => Promise<void>>(
    async () => undefined,
  );
  const focus = vi.fn<(request: ArtifactPreviewCloseRequest) => Promise<void>>(
    async () => undefined,
  );
  const isHostFocused = vi.fn<() => Promise<boolean>>(async () => true);
  let closedListener: (event: ArtifactPreviewClosedEvent) => void;
  let focusReturnedListener: (event: ArtifactPreviewFocusReturnedEvent) => void;
  let previewBounds: DOMRect;

  beforeEach(() => {
    vi.clearAllMocks();
    open.mockResolvedValue(undefined);
    updateBounds.mockResolvedValue(undefined);
    close.mockResolvedValue(undefined);
    focus.mockResolvedValue(undefined);
    isHostFocused.mockResolvedValue(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get: () => document.body,
    });
    previewBounds = {
      x: 10,
      y: 20,
      width: 500,
      height: 400,
      top: 20,
      right: 510,
      bottom: 420,
      left: 10,
      toJSON: () => ({}),
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.hasAttribute('data-chat-container')) {
        return {
          x: 0,
          y: 0,
          width: 800,
          height: 700,
          top: 0,
          right: 800,
          bottom: 700,
          left: 0,
          toJSON: () => ({}),
        };
      }
      return previewBounds;
    });
    closedListener = () => undefined;
    focusReturnedListener = () => undefined;
    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      value: {
        onFocusChange: () => vi.fn(),
        artifactPreview: {
          open,
          updateBounds,
          close,
          focus,
          isHostFocused,
          onClosed: (callback: (event: ArtifactPreviewClosedEvent) => void) => {
            closedListener = callback;
            return vi.fn();
          },
          onFocusReturned: (callback: (event: ArtifactPreviewFocusReturnedEvent) => void) => {
            focusReturnedListener = callback;
            return vi.fn();
          },
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens an artifact-specific sandbox in the message without mounting its HTML', async () => {
    const { container, unmount } = renderPreview();

    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledWith({
      surfaceId: SURFACE_ID,
      artifact: ARTIFACT,
      bounds: { x: 10, y: 20, width: 500, height: 400 },
    });
    expect(screen.getByRole('region', { name: ARTIFACT.title })).toHaveFocus();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container).not.toHaveTextContent('Filter urgent messages');

    fireEvent.click(screen.getByRole('button', { name: 'Interact' }));
    expect(focus).toHaveBeenCalledWith({ surfaceId: SURFACE_ID });

    unmount();
    await waitFor(() => expect(close).toHaveBeenCalledWith({ surfaceId: SURFACE_ID }));
  });

  it('pauses on the first invalid measurement and only reopens after Resume', async () => {
    let finishClose: (() => void) | undefined;
    close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    renderPreview();
    await waitFor(() => expect(open).toHaveBeenCalledOnce());

    previewBounds = { ...previewBounds, y: 900, top: 900, bottom: 1_300 };
    fireEvent.scroll(window);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Interactive result paused while out of view.')).toBeInTheDocument();

    previewBounds = { ...previewBounds, y: 20, top: 20, bottom: 420 };
    fireEvent.scroll(window);
    await act(async () => Promise.resolve());
    expect(open).toHaveBeenCalledOnce();

    finishClose?.();
    fireEvent.click(screen.getByRole('button', { name: 'Resume artifact' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });

  it('remeasures after transcript and outer layout mutations when slot size is unchanged', async () => {
    renderPreview();
    await waitFor(() => expect(open).toHaveBeenCalledOnce());

    const paragraph = document.createElement('p');
    const text = document.createTextNode('Streaming reply');
    paragraph.append(text);
    screen.getByTestId('chat-container').append(paragraph);
    await act(async () => Promise.resolve());
    const updatesBeforeStreaming = updateBounds.mock.calls.length;
    text.data = 'Streaming reply moved the artifact';
    await waitFor(() => expect(updateBounds).toHaveBeenCalledTimes(updatesBeforeStreaming + 1));

    previewBounds = { ...previewBounds, x: 900, left: 900, right: 1_400 };
    document.body.classList.add('pane-layout-changed');

    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(screen.getByText('Interactive result paused while out of view.')).toBeInTheDocument();
  });

  it.each(['fixed inset-0', 'fixed z-99999'])(
    'destroys the sandbox under a %s host overlay and does not auto-resume',
    async (className) => {
      renderPreview();
      await waitFor(() => expect(open).toHaveBeenCalledOnce());

      const overlay = document.createElement('div');
      overlay.className = className;
      document.body.append(overlay);
      await waitFor(() => expect(close).toHaveBeenCalledOnce());

      overlay.remove();
      await act(async () => Promise.resolve());
      expect(open).toHaveBeenCalledOnce();
      expect(
        screen.getByText('Interactive result paused while another control is open.'),
      ).toBeInTheDocument();
    },
  );

  it('ignores non-interactive full-screen ambient layers', async () => {
    renderPreview();
    await waitFor(() => expect(open).toHaveBeenCalledOnce());

    const ambientLayer = document.createElement('div');
    ambientLayer.className = 'fixed inset-0 pointer-events-none';
    document.body.append(ambientLayer);

    await waitFor(() => expect(updateBounds).toHaveBeenCalled());
    expect(close).not.toHaveBeenCalled();
  });

  it('returns focus from the guest, then collapses on host Escape', async () => {
    renderPreview();
    await waitFor(() => expect(open).toHaveBeenCalledOnce());

    const interact = screen.getByRole('button', { name: 'Interact' });
    act(() => focusReturnedListener({ surfaceId: SURFACE_ID }));
    expect(interact).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('region', { name: ARTIFACT.title }), { key: 'Escape' });
    expect(await screen.findByTestId('artifact-closed')).toBeInTheDocument();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it('keeps native suspension and failure recoverable inline', async () => {
    renderPreview();
    await waitFor(() => expect(open).toHaveBeenCalledOnce());

    act(() => closedListener({ surfaceId: SURFACE_ID, reason: 'suspended' }));
    expect(screen.getByText('Interactive result paused.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Resume artifact' })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume artifact' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));

    act(() => closedListener({ surfaceId: SURFACE_ID, reason: 'failed' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Interactive result stopped responding.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus());
  });

  it('shows an inline retry when the sandbox cannot open', async () => {
    open.mockRejectedValueOnce(new Error('guest failed'));
    const { container } = renderPreview();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Interactive result could not be opened.',
    );
    expect(container.querySelector('iframe')).toBeNull();

    expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });

  it('still opens when host focus resolves before the first scheduled frame runs', async () => {
    // Real frame queue: the shared stub runs every frame immediately, so it can
    // never produce a genuinely cancelled frame.
    const frames = new Map<number, FrameRequestCallback>();
    let lastFrameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      lastFrameId += 1;
      frames.set(lastFrameId, callback);
      return lastFrameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    let reportHostFocused: (isFocused: boolean) => void = () => undefined;
    isHostFocused.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        reportHostFocused = resolve;
      }),
    );

    renderPreview();
    // Cancels the mount frame and reschedules against the resolved host state.
    await act(async () => reportHostFocused(true));
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => {
      for (const runFrame of pending) runFrame(0);
    });

    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(screen.queryByText('Preparing interactive result…')).toBeNull();
  });
});
