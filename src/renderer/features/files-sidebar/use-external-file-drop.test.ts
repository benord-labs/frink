// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fileUriOrPathToPath,
  getExternalFilePathsFromClipboard,
  parseFilePathsFromDataTransfer,
  useExternalFileDrop,
} from './use-external-file-drop';

/** Build a minimal DataTransfer whose getData returns mapped strings (others empty). */
function makeDataTransfer(data: Record<string, string>, files: File[] = []): DataTransfer {
  return {
    getData: (type: string) => data[type] ?? '',
    files,
  } as unknown as DataTransfer;
}

describe('fileUriOrPathToPath', () => {
  it('strips file:// and file:/// prefixes to an absolute path', () => {
    expect(fileUriOrPathToPath('file:///Users/me/file.txt')).toBe('/Users/me/file.txt');
    expect(fileUriOrPathToPath('file://Users/me/file.txt')).toBe('/Users/me/file.txt');
  });

  it('strips a localhost host segment', () => {
    expect(fileUriOrPathToPath('file://localhost/Users/me/file.txt')).toBe('/Users/me/file.txt');
  });

  it('URL-decodes encoded path segments', () => {
    expect(fileUriOrPathToPath('file:///Users/me/my%20file.txt')).toBe('/Users/me/my file.txt');
  });

  it('falls back to the raw path when decoding fails', () => {
    expect(fileUriOrPathToPath('file:///bad%2.txt')).toBe('/bad%2.txt');
  });

  it('passes a plain absolute path through unchanged', () => {
    expect(fileUriOrPathToPath('/Users/me/file.txt')).toBe('/Users/me/file.txt');
  });

  it('handles Windows drive paths without prepending a slash', () => {
    expect(fileUriOrPathToPath('file:///C:/Users/me/file.txt')).toBe('C:/Users/me/file.txt');
    expect(fileUriOrPathToPath('C:\\Users\\me')).toBe('C:\\Users\\me');
  });
});

describe('parseFilePathsFromDataTransfer', () => {
  it('parses a JSON array of file:// URLs', () => {
    const dt = makeDataTransfer({
      'text/uri-list': '["file:///Users/a.txt","file:///Users/b.txt"]',
    });
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/Users/a.txt', '/Users/b.txt']);
  });

  it('parses newline-separated file:// URIs and absolute paths', () => {
    const dt = makeDataTransfer({
      'text/uri-list': 'file:///Users/a.txt\n/Users/b.txt',
    });
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/Users/a.txt', '/Users/b.txt']);
  });

  it('newline branch rejects relative and non-file:// entries (poisoning guard)', () => {
    const dt = makeDataTransfer({
      'text/uri-list': 'not-a-path\nrelative/path\n/Users/ok.txt',
    });
    // Only the strict absolute path survives; arbitrary clipboard text is dropped.
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/Users/ok.txt']);
  });

  it('JSON branch bypasses the poisoning guard and accepts arbitrary strings', () => {
    const dt = makeDataTransfer({
      'text/uri-list': '["evil-not-a-path","../../etc/passwd"]',
    });
    // KNOWN ASYMMETRY: unlike the newline branch, the JSON branch does not gate on
    // file:// / absolute, so non-path strings pass through. Documented, not fixed here.
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['evil-not-a-path', '../../etc/passwd']);
  });

  it('passes file:// URIs containing traversal segments through (rejected downstream)', () => {
    const dt = makeDataTransfer({ 'text/uri-list': 'file:///Users/../etc/passwd' });
    // Renderer does not resolve traversal; main-process files.duplicate is the guard.
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/Users/../etc/passwd']);
  });

  it('keeps a non-localhost host as a leading path segment', () => {
    const dt = makeDataTransfer({ 'text/uri-list': 'file://example.com/share/file.txt' });
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/example.com/share/file.txt']);
  });

  it('returns an empty array when no recognised data is present', () => {
    expect(parseFilePathsFromDataTransfer(makeDataTransfer({}))).toEqual([]);
    expect(parseFilePathsFromDataTransfer(makeDataTransfer({ 'text/plain': '   ' }))).toEqual([]);
  });

  it('parses Cursor resourceurls (URL-encoded JSON array)', () => {
    const dt = makeDataTransfer({
      resourceurls: '["file:///Users/me/a%20b.txt","file:///Users/me/c.txt"]',
    });
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/Users/me/a b.txt', '/Users/me/c.txt']);
  });

  it('parses VSCode codefiles (JSON array of plain absolute paths)', () => {
    const dt = makeDataTransfer({ codefiles: '["/Users/a.txt","/Users/b.txt"]' });
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/Users/a.txt', '/Users/b.txt']);
  });

  it('falls through to a later type when an earlier type yields no valid paths', () => {
    const dt = makeDataTransfer({
      'text/uri-list': 'garbage-text',
      resourceurls: '["file:///Users/ok.txt"]',
    });
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/Users/ok.txt']);
  });

  it('handles CRLF line endings', () => {
    const dt = makeDataTransfer({
      'text/uri-list': 'file:///Users/a.txt\r\n/Users/b.txt',
    });
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/Users/a.txt', '/Users/b.txt']);
  });

  it('returns [] when JSON parsing throws on a malformed array', () => {
    const dt = makeDataTransfer({ 'text/uri-list': '[not valid json' });
    expect(parseFilePathsFromDataTransfer(dt)).toEqual([]);
  });

  it('skips non-string entries in a JSON array', () => {
    const dt = makeDataTransfer({ 'text/uri-list': '[123, null, "file:///Users/a.txt"]' });
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/Users/a.txt']);
  });

  it('continues to the next type when getData throws', () => {
    const dt = {
      getData: (type: string) => {
        if (type === 'text/uri-list') throw new Error('protected type');
        if (type === 'resourceurls') return '["file:///Users/ok.txt"]';
        return '';
      },
      files: [],
    } as unknown as DataTransfer;
    expect(parseFilePathsFromDataTransfer(dt)).toEqual(['/Users/ok.txt']);
  });
});

describe('getExternalFilePathsFromClipboard', () => {
  type WebUtilsWindow = Window & { webUtils?: { getPathForFile?: (f: File) => string } };

  afterEach(() => {
    delete (window as WebUtilsWindow).webUtils;
  });

  it('returns [] for null clipboard data', () => {
    expect(getExternalFilePathsFromClipboard(null)).toEqual([]);
  });

  it('uses webUtils.getPathForFile when available', () => {
    (window as WebUtilsWindow).webUtils = { getPathForFile: () => '/Users/dropped.txt' };
    const dt = makeDataTransfer({}, [new File([], 'dropped.txt')]);
    expect(getExternalFilePathsFromClipboard(dt)).toEqual(['/Users/dropped.txt']);
  });

  it('falls back to parsing data transfer when webUtils is absent', () => {
    const dt = makeDataTransfer({ 'text/uri-list': 'file:///Users/fallback.txt' }, [
      new File([], 'fallback.txt'),
    ]);
    expect(getExternalFilePathsFromClipboard(dt)).toEqual(['/Users/fallback.txt']);
  });
});

describe('useExternalFileDrop conflict resolution', () => {
  type WebUtilsWindow = Window & { webUtils?: { getPathForFile?: (f: File) => string } };

  afterEach(() => {
    delete (window as WebUtilsWindow).webUtils;
    vi.restoreAllMocks();
  });

  function setup(getDestinationFolder?: () => string) {
    (window as WebUtilsWindow).webUtils = { getPathForFile: () => '/Users/dropped.txt' };
    // happy-dom lacks elementsFromPoint; drop target resolution falls back to root.
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
    const copyExternalFilesMutate = vi.fn();
    const { result } = renderHook(() =>
      useExternalFileDrop({
        projectPath: '/Users/project',
        treeContainerRef: { current: null },
        enabled: true,
        copyExternalFilesMutate,
        getDestinationFolder,
      }),
    );
    return { result, copyExternalFilesMutate };
  }

  it('drops with keepBoth so existing files are never silently overwritten', () => {
    const { result, copyExternalFilesMutate } = setup();
    const event = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File([], 'a.txt')], types: ['Files'] },
      clientX: 0,
      clientY: 0,
    } as unknown as React.DragEvent;

    act(() => result.current.onDrop(event));

    expect(copyExternalFilesMutate).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'keepBoth' }),
    );
  });

  it('pastes with keepBoth so existing files are never silently overwritten', () => {
    const { result, copyExternalFilesMutate } = setup(() => 'sub');
    const event = {
      preventDefault: vi.fn(),
      clipboardData: makeDataTransfer({}, [new File([], 'a.txt')]),
    } as unknown as React.ClipboardEvent;

    act(() => result.current.onPaste(event));

    expect(copyExternalFilesMutate).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'keepBoth' }),
    );
  });

  // External Cmd+V is best-effort: many apps expose no file path on the clipboard (Electron#39853).
  // When paste yields no paths, it must no-op — no mutation, no preventDefault — so the caller can
  // fall through to internal copy/paste. Drag-and-drop is the supported path (see user-docs/files.md).
  it('no-ops on a paste with no file paths so internal paste can still run', () => {
    const { result, copyExternalFilesMutate } = setup();
    const preventDefault = vi.fn();
    const event = {
      preventDefault,
      clipboardData: makeDataTransfer({}, []),
    } as unknown as React.ClipboardEvent;

    act(() => result.current.onPaste(event));

    expect(copyExternalFilesMutate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  // Wiring guard: the line "mutate was called" is not enough — a broken getDestinationFolder would
  // silently land pastes in the wrong folder, and a missing preventDefault would let handlePasteEvent
  // fall through and ALSO run the internal paste (double import) for the same keystroke.
  it('pastes resolved paths into the destination folder and prevents default so internal paste cannot also run', () => {
    const { result, copyExternalFilesMutate } = setup(() => 'sub');
    const preventDefault = vi.fn();
    const event = {
      preventDefault,
      clipboardData: makeDataTransfer({}, [new File([], 'a.txt')]),
    } as unknown as React.ClipboardEvent;

    act(() => result.current.onPaste(event));

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(copyExternalFilesMutate).toHaveBeenCalledWith({
      sourcePaths: ['/Users/dropped.txt'],
      projectPath: '/Users/project',
      destinationFolder: 'sub',
      resolution: 'keepBoth',
    });
  });

  // No selection → destination falls back to project root (''). Exercises the `?? ''` branch.
  it('pastes to the project root when no destination folder is provided', () => {
    const { result, copyExternalFilesMutate } = setup();
    const event = {
      preventDefault: vi.fn(),
      clipboardData: makeDataTransfer({}, [new File([], 'a.txt')]),
    } as unknown as React.ClipboardEvent;

    act(() => result.current.onPaste(event));

    expect(copyExternalFilesMutate).toHaveBeenCalledWith(
      expect.objectContaining({ destinationFolder: '' }),
    );
  });
});
