import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from '../claude/types';
import { reportIfControlChannelClosed } from './stream-closed-sentinel';

const { captureMainMessage } = vi.hoisted(() => ({ captureMainMessage: vi.fn() }));
vi.mock('../sentry/init', () => ({ captureMainMessage }));

describe('reportIfControlChannelClosed', () => {
  beforeEach(() => captureMainMessage.mockClear());

  it('reports a tool-output-error carrying "Stream closed" (tagged by subChat)', async () => {
    reportIfControlChannelClosed(
      {
        type: 'tool-output-error',
        toolCallId: 't1',
        errorText: 'Error: Stream closed',
      } as UIMessageChunk,
      'sub-1',
    );
    // Sentry is loaded lazily (dynamic import), so the capture lands on a later microtask.
    await vi.waitFor(() =>
      expect(captureMainMessage).toHaveBeenCalledWith(
        expect.stringContaining('control channel'),
        'error',
        { subChatId: 'sub-1' },
      ),
    );
  });

  it('ignores an unrelated tool-output-error (e.g. a normal permission denial)', () => {
    reportIfControlChannelClosed(
      {
        type: 'tool-output-error',
        toolCallId: 't1',
        errorText: 'Permission denied',
      } as UIMessageChunk,
      'sub-1',
    );
    expect(captureMainMessage).not.toHaveBeenCalled();
  });

  it('ignores non-error chunks', () => {
    reportIfControlChannelClosed({ type: 'text-delta', delta: 'hi' } as UIMessageChunk, 'sub-1');
    expect(captureMainMessage).not.toHaveBeenCalled();
  });
});
