import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ArtifactPreviewIpcRenderer,
  createArtifactPreviewApi,
  createArtifactPreviewTransport,
} from './artifact-preview';

const electron = {
  invoke: vi.fn(async (channel: string) =>
    channel === 'artifact-preview:is-host-focused' ? true : undefined,
  ),
  on: vi.fn(),
  removeListener: vi.fn(),
} satisfies ArtifactPreviewIpcRenderer;
const artifactPreviewApi = createArtifactPreviewApi(createArtifactPreviewTransport(electron));

const validOpenRequest = {
  surfaceId: 'pane:0',
  bounds: { x: 10, y: 20, width: 500, height: 400 },
  artifact: {
    version: 1 as const,
    artifactId: 'artifact:1',
    title: 'Customer digest',
    bodyHtml: '<main>18 messages</main>',
  },
};

describe('artifactPreviewApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates every outbound request before invoking main', async () => {
    await expect(artifactPreviewApi.open(validOpenRequest)).resolves.toBeUndefined();
    await expect(
      artifactPreviewApi.updateBounds({ surfaceId: 'pane:0', bounds: validOpenRequest.bounds }),
    ).resolves.toBeUndefined();
    await expect(artifactPreviewApi.focus({ surfaceId: 'pane:0' })).resolves.toBeUndefined();
    await expect(artifactPreviewApi.close({ surfaceId: 'pane:0' })).resolves.toBeUndefined();
    await expect(artifactPreviewApi.isHostFocused()).resolves.toBe(true);

    expect(electron.invoke).toHaveBeenNthCalledWith(1, 'artifact-preview:open', validOpenRequest);
    expect(electron.invoke).toHaveBeenNthCalledWith(2, 'artifact-preview:update-bounds', {
      surfaceId: 'pane:0',
      bounds: validOpenRequest.bounds,
    });
    expect(electron.invoke).toHaveBeenNthCalledWith(3, 'artifact-preview:focus', {
      surfaceId: 'pane:0',
    });
    expect(electron.invoke).toHaveBeenNthCalledWith(4, 'artifact-preview:close', {
      surfaceId: 'pane:0',
    });
    expect(electron.invoke).toHaveBeenNthCalledWith(5, 'artifact-preview:is-host-focused');

    expect(() => artifactPreviewApi.open({ ...validOpenRequest, surfaceId: '' })).toThrow(
      /invalid artifact preview/i,
    );
    expect(() =>
      artifactPreviewApi.updateBounds({
        surfaceId: 'pane:0',
        bounds: { ...validOpenRequest.bounds, width: 0 },
      }),
    ).toThrow(/invalid preview bounds/i);
    expect(() => artifactPreviewApi.close({ surfaceId: '' })).toThrow(/invalid preview close/i);
    expect(() => artifactPreviewApi.focus({ surfaceId: '' })).toThrow(/invalid preview focus/i);
    expect(electron.invoke).toHaveBeenCalledTimes(5);
  });

  it('delivers only validated close events and removes the exact listener', () => {
    const callback = vi.fn();
    const unsubscribe = artifactPreviewApi.onClosed(callback);
    const handler = electron.on.mock.calls[0]?.[1];

    expect(electron.on).toHaveBeenCalledWith('artifact-preview:closed', expect.any(Function));
    handler({}, null);
    handler({}, { surfaceId: '' });
    handler({}, { surfaceId: 'x'.repeat(201) });
    handler({}, { surfaceId: 'pane:0' });
    handler({}, { surfaceId: 'pane:0', reason: 'unknown' });
    expect(callback).not.toHaveBeenCalled();

    handler({}, { surfaceId: 'pane:0', reason: 'dismissed' });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ surfaceId: 'pane:0', reason: 'dismissed' });

    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith('artifact-preview:closed', handler);
  });

  it('rejects a non-function close listener immediately', () => {
    expect(() => artifactPreviewApi.onClosed(null)).toThrow(/invalid.*callback/i);
    expect(electron.on).not.toHaveBeenCalled();
  });

  it('delivers only validated focus-returned events', () => {
    const callback = vi.fn();
    const unsubscribe = artifactPreviewApi.onFocusReturned(callback);
    const handler = electron.on.mock.calls[0]?.[1];

    expect(electron.on).toHaveBeenCalledWith(
      'artifact-preview:focus-returned',
      expect.any(Function),
    );
    handler({}, { surfaceId: '' });
    handler({}, { surfaceId: 'pane:0' });
    expect(callback).toHaveBeenCalledWith({ surfaceId: 'pane:0' });

    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(
      'artifact-preview:focus-returned',
      handler,
    );
  });
});
