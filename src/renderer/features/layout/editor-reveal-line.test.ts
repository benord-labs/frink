// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchEditorRevealLine } from './editor-reveal-line';

describe('dispatchEditorRevealLine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches editor:reveal-line with file path, line number, and range', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    dispatchEditorRevealLine('/repo/src/app.ts', 42, 5, 11);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]?.[0] as CustomEvent<{
      filePath: string;
      lineNumber: number;
      startColumn?: number;
      endColumn?: number;
    }>;
    expect(event.type).toBe('editor:reveal-line');
    expect(event.detail).toEqual({
      filePath: '/repo/src/app.ts',
      lineNumber: 42,
      startColumn: 5,
      endColumn: 11,
    });
  });

  it('dispatches editor:reveal-line without range when columns are omitted', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    dispatchEditorRevealLine('/repo/src/app.ts', 7);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]?.[0] as CustomEvent<{
      filePath: string;
      lineNumber: number;
      startColumn?: number;
      endColumn?: number;
    }>;
    expect(event.type).toBe('editor:reveal-line');
    expect(event.detail).toEqual({
      filePath: '/repo/src/app.ts',
      lineNumber: 7,
      startColumn: undefined,
      endColumn: undefined,
    });
  });
});
