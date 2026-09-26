import { describe, expect, it } from 'vitest';
import {
  getSplitPaneTerminalsForContent,
  getVisibleTerminalTabsForStrip,
  isSplitLayoutVisible,
  isSplitStripTabActive,
  normalizeSplitPaneIds,
  resolveSplitPaneInstances,
  tabScrollTargetIdForActivePane,
} from './terminal-split-helpers';
import type { TerminalInstance } from './types';

function t(id: string): TerminalInstance {
  return {
    id,
    paneId: `chat:term:${id}`,
    name: `Terminal ${id}`,
    createdAt: 0,
  };
}

describe('resolveSplitPaneInstances', () => {
  it('returns instances in id order and skips missing', () => {
    const terminals = [t('a'), t('b'), t('c')];
    expect(resolveSplitPaneInstances(terminals, ['c', 'a', 'missing'])).toEqual([
      terminals[2],
      terminals[0],
    ]);
  });
});

describe('getVisibleTerminalTabsForStrip', () => {
  it('hides non-primary sessions when strip has 2+ panes', () => {
    const terminals = [t('a'), t('b'), t('c')];
    expect(getVisibleTerminalTabsForStrip(terminals, ['a', 'b'])).toEqual([
      terminals[0],
      terminals[2],
    ]);
  });
});

describe('isSplitLayoutVisible', () => {
  it('is true when the active session is in the strip', () => {
    expect(isSplitLayoutVisible(['a', 'b'], 'a', 2)).toBe(true);
    expect(isSplitLayoutVisible(['a', 'b'], 'b', 2)).toBe(true);
  });

  it('is false when a tab outside the strip is selected (group stays for badges, single column for content)', () => {
    expect(isSplitLayoutVisible(['a', 'b'], 'c', 2)).toBe(false);
  });

  it('is false when fewer than two resolved panes', () => {
    expect(isSplitLayoutVisible(['a'], 'a', 1)).toBe(false);
  });
});

describe('getSplitPaneTerminalsForContent', () => {
  it('returns empty when active tab is not in the strip (preserves grouping in tab state)', () => {
    const terminals = [t('a'), t('b'), t('c')];
    const resolved = resolveSplitPaneInstances(terminals, ['a', 'b']);
    expect(getSplitPaneTerminalsForContent(resolved, ['a', 'b'], 'c')).toEqual([]);
  });

  it('returns full strip when active is a pane in the group', () => {
    const terminals = [t('a'), t('b')];
    const resolved = resolveSplitPaneInstances(terminals, ['a', 'b']);
    expect(getSplitPaneTerminalsForContent(resolved, ['a', 'b'], 'b')).toEqual(resolved);
  });
});

describe('isSplitStripTabActive', () => {
  it('is true when keyboard focus is a secondary pane', () => {
    expect(isSplitStripTabActive('a', 'a', 'b', ['a', 'b'])).toBe(true);
  });

  it('highlights group tab when only keyboard is in the strip', () => {
    expect(isSplitStripTabActive('a', 'c', 'b', ['a', 'b'])).toBe(true);
  });
});

describe('tabScrollTargetIdForActivePane', () => {
  it('maps secondary active pane to primary tab id for scrolling', () => {
    expect(tabScrollTargetIdForActivePane('b', 'b', ['a', 'b'])).toBe('a');
  });

  it('uses the out-of-strip active id when another tab is selected', () => {
    expect(tabScrollTargetIdForActivePane('c', null, ['a', 'b'])).toBe('c');
  });

  it('targets primary when only keyboard focus is in the strip (active selection null)', () => {
    expect(tabScrollTargetIdForActivePane(null, 'b', ['a', 'b'])).toBe('a');
  });

  it('returns null when no strip focus is in the group and active is null', () => {
    expect(tabScrollTargetIdForActivePane(null, null, ['a', 'b'])).toBeNull();
  });
});

describe('normalizeSplitPaneIds', () => {
  it('removes stale ids and collapses when fewer than two valid remain', () => {
    const terminals = [t('a'), t('b')];
    expect(normalizeSplitPaneIds(['a', 'gone', 'b'], terminals)).toEqual(['a', 'b']);
    expect(normalizeSplitPaneIds(['a'], terminals)).toEqual([]);
  });

  it('dedupes duplicate ids', () => {
    const terminals = [t('a'), t('b')];
    expect(normalizeSplitPaneIds(['a', 'a', 'b'], terminals)).toEqual(['a', 'b']);
  });
});
