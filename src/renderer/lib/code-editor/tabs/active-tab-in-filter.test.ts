import { describe, expect, it } from 'vitest';
import { fileKey } from '@/lib/code-editor/state';
import { activeTabInFilter } from './active-tab-in-filter';

const tab = (path: string) => ({ path, name: path, projectPath: '/repo' });
const [a, b, c] = [tab('a.ts'), tab('b.ts'), tab('c.ts')];
const [keyA, keyB, keyC] = [a, b, c].map((file) => fileKey(file.path, file.projectPath));

describe('activeTabInFilter', () => {
  it.each([
    ['keeps the active tab while the bar shows all tabs', [a, b], keyB, false, undefined, keyB],
    ['keeps the active tab while the pane shows it', [a, b], keyB, true, keyA, keyB],
    [
      "moves to the pane's first tab when it hides the active one",
      [b],
      keyA,
      true,
      undefined,
      keyB,
    ],
    ["moves to the pane's last tab when it hides the active one", [a, b], keyC, true, keyB, keyB],
    [
      'moves to the first tab when the pane has closed its last tab',
      [a, b],
      keyC,
      true,
      keyC,
      keyA,
    ],
    // Pane 1's tab must not stay in the editor under pane 2's "No files from this pane".
    ['shows no tab for a pane with no tabs', [], keyA, true, undefined, null],
    ["shows the pane's last tab when no tab is active", [a, b], null, true, keyB, keyB],
    ['shows the first tab again once the filter is off', [a, b], null, false, undefined, keyA],
  ])('%s', (_case, visibleFiles, activePath, isFiltered, paneLastTab, shown) => {
    expect(activeTabInFilter(visibleFiles, activePath, isFiltered, paneLastTab)).toBe(shown);
  });
});
