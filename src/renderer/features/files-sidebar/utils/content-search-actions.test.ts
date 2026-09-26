// @vitest-environment happy-dom
import type { RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  activateSearchTabAndFocus,
  openContentSearchMatchInEditor,
  shouldHandlePaneSearchActivation,
} from './content-search-actions';

describe('content-search-actions', () => {
  it('activates search tab and focuses input', () => {
    const setActiveTab = vi.fn();
    const focus = vi.fn();
    const select = vi.fn();
    const inputRef = { current: { focus, select } } as unknown as RefObject<HTMLInputElement>;
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });

    activateSearchTabAndFocus(setActiveTab, inputRef);

    expect(setActiveTab).toHaveBeenCalledWith('search');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    rafSpy.mockRestore();
  });

  it('opens matched file and dispatches reveal-line event with match range', () => {
    const onOpenAbsoluteFile = vi.fn();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });

    openContentSearchMatchInEditor('/repo', 'src/app.ts', 12, 8, 14, onOpenAbsoluteFile);

    expect(onOpenAbsoluteFile).toHaveBeenCalledWith('/repo/src/app.ts');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]?.[0] as CustomEvent<{
      filePath: string;
      lineNumber: number;
      startColumn: number;
      endColumn: number;
    }>;
    expect(event.type).toBe('editor:reveal-line');
    expect(event.detail).toEqual({
      filePath: '/repo/src/app.ts',
      lineNumber: 12,
      startColumn: 8,
      endColumn: 14,
    });
    expect(onOpenAbsoluteFile.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchSpy.mock.invocationCallOrder[0],
    );
    rafSpy.mockRestore();
  });

  it('matches pane activation by pane index', () => {
    expect(shouldHandlePaneSearchActivation({ paneIndex: 2 }, 2)).toBe(true);
    expect(shouldHandlePaneSearchActivation({ paneIndex: 1 }, 2)).toBe(false);
    expect(shouldHandlePaneSearchActivation(undefined, 2)).toBe(false);
  });
});
