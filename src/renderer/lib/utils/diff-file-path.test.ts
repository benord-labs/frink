// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  getCodeViewFilePath,
  getCodeViewFilePathFromEvent,
  getDisplayPath,
} from './diff-file-path';

describe('getDisplayPath', () => {
  it('prefers newPath when it is not /dev/null', () => {
    expect(
      getDisplayPath({
        newPath: 'src/new.ts',
        oldPath: 'src/old.ts',
        key: 'old->new',
      }),
    ).toBe('src/new.ts');
  });

  it('falls back to oldPath when newPath is /dev/null', () => {
    expect(
      getDisplayPath({
        newPath: '/dev/null',
        oldPath: 'src/deleted.ts',
        key: 'deleted-key',
      }),
    ).toBe('src/deleted.ts');
  });

  it('falls back to key when both paths are /dev/null or empty', () => {
    expect(
      getDisplayPath({
        newPath: '/dev/null',
        oldPath: '/dev/null',
        key: 'binary-key',
      }),
    ).toBe('binary-key');
  });
});

function renderCodeViewItem(title: string) {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div data-diffs-header><div data-title><bdi>${title}</bdi></div></div><pre><span data-line>x</span></pre>`;
  document.body.append(host);
  return { root, line: root.querySelector('[data-line]') };
}

describe('getCodeViewFilePath', () => {
  it('reads the file path from the item header', () => {
    const { root } = renderCodeViewItem('src/app.ts');
    expect(getCodeViewFilePath(root)).toBe('src/app.ts');
  });

  it('keeps a path with leading or trailing spaces exactly as git names it', () => {
    const { root } = renderCodeViewItem(' src/app.ts ');
    expect(getCodeViewFilePath(root)).toBe(' src/app.ts ');
  });

  it('is null for a shadow root that is not a CodeView item', () => {
    const host = document.createElement('div');
    expect(getCodeViewFilePath(host.attachShadow({ mode: 'open' }))).toBeNull();
  });

  it('resolves the file for an event fired on a line inside the item', () => {
    const { line } = renderCodeViewItem('src/lib/util.ts');
    let path: string | null = null;
    line?.addEventListener('contextmenu', (event) => {
      path = getCodeViewFilePathFromEvent(event);
    });
    line?.dispatchEvent(new Event('contextmenu', { bubbles: true, composed: true }));
    expect(path).toBe('src/lib/util.ts');
  });
});
