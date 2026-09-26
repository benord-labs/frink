import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_MODELS_CATALOG,
  CODEX_MODELS,
  claudeModelToPickerItem,
  codexModelToPickerItem,
} from '../models';
import { findPickerSelection, groupPickerModels, pickInWindow } from './groups';

const claude = groupPickerModels(CLAUDE_CODE_MODELS_CATALOG.map(claudeModelToPickerItem));
const family = (label: string) => {
  const f = claude.find((x) => x.label === label);
  if (!f) throw new Error(`no family ${label}`);
  return f;
};
const ids = (tiers: { id: string }[]) => tiers.map((t) => t.id);

describe('groupPickerModels', () => {
  it('gives each family one entry, with its windows inside and 1M the default', () => {
    const opus = family('Opus 4.7');
    expect(opus.windows.map((w) => w.label)).toEqual(['200k', '1M']);
    expect(opus.defaultWindow.label).toBe('1M');
    expect(claude.some((f) => f.label.includes('· 1M'))).toBe(false);
  });

  it('ranks tiers by effort key regardless of catalog order', () => {
    expect(ids(family('Opus 4.7').windows[0].tiers)).toEqual([
      'opus-4.7-low',
      'opus-4.7',
      'opus-4.7-high',
      'opus-4.7-xhigh',
      'opus-4.7-max',
      'opus-4.7-ultra',
    ]);
    expect(ids(family('Sonnet 4.6').windows[0].tiers)).toEqual([
      'sonnet-low',
      'sonnet',
      'sonnet-high',
    ]);
  });

  it('gives a 1M-native family a single window defaulting to its bare id', () => {
    const opus5 = family('Opus 5');
    expect(opus5.windows).toHaveLength(1);
    expect(opus5.defaultWindow.defaultTier.id).toBe('opus-5');
  });

  it('gives Haiku a single window with a single tier (nothing to tune)', () => {
    expect(ids(family('Haiku 4.5').windows[0].tiers)).toEqual(['haiku']);
  });

  it('groups each Codex model into one window with the medium default', () => {
    const [astra] = groupPickerModels(CODEX_MODELS.map(codexModelToPickerItem));
    expect(astra.label).toBe('GPT-6 Astra');
    expect(astra.windows).toHaveLength(1);
    expect(astra.windows[0].tiers.map((t) => t.detail)).toEqual([
      'Low',
      'Medium',
      'High',
      'Extra High',
    ]);
    expect(astra.defaultWindow.defaultTier.id).toBe('codex-gpt-6-astra-medium');
  });
});

describe('findPickerSelection', () => {
  it('locates the family and window of an id, and misses an unknown one', () => {
    const hit = findPickerSelection(claude, 'opus-4.7-1m-high');
    expect(hit?.family.label).toBe('Opus 4.7');
    expect(hit?.window.label).toBe('1M');
    expect(findPickerSelection(claude, 'gone')).toBeUndefined();
  });
});

describe('pickInWindow', () => {
  it('keeps the effort when the window offers it', () => {
    expect(pickInWindow(family('Opus 4.6').defaultWindow, 'high').id).toBe('opus-1m-high');
  });

  it('falls back to the window default when the tier is missing', () => {
    expect(pickInWindow(family('Opus 4.6').defaultWindow, 'max').id).toBe('opus-1m');
    expect(pickInWindow(family('Haiku 4.5').defaultWindow, 'high').id).toBe('haiku');
  });
});
