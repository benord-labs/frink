import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../palette/color';
import { derivePalette } from '../palette/derive';
import { type Half, MAX_THEME_NAME_LENGTH, type ThemeDefinition } from '../palette/theme-schema';
import {
  editRole,
  isDraftChanged,
  isSeed,
  isUserOverride,
  otherThemes,
  parseHexColor,
  resetDraftRole,
  resetRole,
  setRoleColor,
  statedColor,
  themeNameForSave,
  startDraft,
  themeToSave,
  upsertTheme,
} from './draft';

const HALF: Half = { background: '#faf9f5', accent: '#b05230', syntax: 'github-light' };

function theme(id: string, name: string): ThemeDefinition {
  return {
    id,
    name,
    light: HALF,
    dark: { background: '#262624', accent: '#d97857', syntax: 'github-dark' },
  };
}

describe('role edits', () => {
  it('sets Background and Accent as seeds and pins any other role as an override', () => {
    expect(setRoleColor(HALF, 'accent', '#0034ff')).toEqual({ ...HALF, accent: '#0034ff' });
    expect(setRoleColor(HALF, 'border', '#cccccc')).toEqual({
      ...HALF,
      overrides: { border: '#cccccc' },
    });
  });

  it('re-derives only roles without an override when a seed moves, and reset derives again', () => {
    const moved = setRoleColor(setRoleColor(HALF, 'text', '#123456'), 'background', '#fdf6e3');
    const derivedFromSeeds = derivePalette({ ...HALF, background: '#fdf6e3' });

    expect(derivePalette(moved).text).toBe('#123456');
    expect(derivePalette(moved).surface).toBe(derivedFromSeeds.surface);
    expect(derivedFromSeeds.surface).not.toBe(derivePalette(HALF).surface);
    expect(derivePalette(resetRole(moved, 'text')).text).toBe(derivedFromSeeds.text);
  });
});

describe('a copy of Frink', () => {
  // Stock snapshots every non-seed role as an override, so the copy starts identical to Frink.
  const frink: ThemeDefinition = {
    ...theme('frink-copy', 'Frink copy'),
    light: {
      background: '#ffffff',
      accent: '#16a34a',
      syntax: 'github-light',
      overrides: {
        surface: '#fafafa',
        text: '#0a0a0a',
        accentForeground: '#ffffff',
        border: '#e5e5e5',
      },
    },
  };
  const copy = { seed: frink, mode: 'create' } as const;
  const light = (draft: ReturnType<typeof startDraft>) => draft.theme.light;

  it('keeps every inherited colour and marks none as changed until a seed moves', () => {
    const draft = startDraft(copy);
    expect(draft.theme).toBe(frink);
    expect(isUserOverride(light(draft), draft.inherited.light, 'text')).toBe(false);
  });

  it('re-derives inherited roles, readably, when Accent or Background changes', () => {
    const accent = light(editRole(startDraft(copy), 'light', 'accent', '#ffe066'));
    const onAccent = derivePalette(accent);
    expect(accent.overrides).toEqual({});
    expect(contrastRatio(onAccent.accentForeground, '#ffe066')).toBeGreaterThanOrEqual(4.5);

    const navy = derivePalette(light(editRole(startDraft(copy), 'light', 'background', '#1a1a2e')));
    expect(contrastRatio(navy.text, '#1a1a2e')).toBeGreaterThanOrEqual(4.5);
    expect(navy.surface).not.toBe('#fafafa');
  });

  it('keeps a role the user set through a seed change, and reset derives it again', () => {
    const pinned = editRole(startDraft(copy), 'light', 'text', '#123456');
    expect(isUserOverride(light(pinned), pinned.inherited.light, 'text')).toBe(true);

    const moved = editRole(pinned, 'light', 'accent', '#ffe066');
    expect(light(moved).overrides).toEqual({ text: '#123456' });
    expect(moved.theme.dark).toBe(frink.dark);

    const reset = light(resetDraftRole(moved, 'light', 'text'));
    expect(reset.overrides).toEqual({});
    expect(derivePalette(reset).text).toBe(
      derivePalette({ background: '#ffffff', accent: '#ffe066' }).text,
    );
  });
  it("keeps an edited theme's saved overrides through a seed change", () => {
    const edited = startDraft({ seed: frink, mode: 'edit' });
    expect(isUserOverride(light(edited), edited.inherited.light, 'text')).toBe(true);
    expect(light(editRole(edited, 'light', 'accent', '#ffe066')).overrides).toEqual(
      frink.light.overrides,
    );
  });
});

describe('statedColor', () => {
  it('reads a seed from the half and any other role from its overrides', () => {
    const half = setRoleColor(HALF, 'text', '#123456');
    expect(statedColor(half, 'accent')).toBe('#b05230');
    expect(statedColor(half, 'text')).toBe('#123456');
    expect(statedColor(half, 'border')).toBeUndefined();
    expect([isSeed('background'), isSeed('accent'), isSeed('text')]).toEqual([true, true, false]);
  });
});

describe('parseHexColor', () => {
  it('accepts six hex digits with or without #, and nothing else', () => {
    expect(parseHexColor(' B05230 ')).toBe('#b05230');
    expect(parseHexColor('#B05230')).toBe('#b05230');
    expect(parseHexColor('#b0523')).toBeNull();
    expect(parseHexColor('red')).toBeNull();
  });
});

describe('isDraftChanged', () => {
  const seed = theme('clay-copy', 'Clay copy');

  it('ignores an override that was reset or re-added in another key order', () => {
    const pinned: ThemeDefinition = {
      ...seed,
      light: { ...HALF, overrides: { surface: '#eeeeee', text: '#111111' } },
    };
    const reordered: ThemeDefinition = {
      ...seed,
      light: { ...HALF, overrides: { text: '#111111', surface: '#eeeeee' } },
    };
    const resetBack = {
      ...seed,
      light: resetRole(setRoleColor(HALF, 'border', '#cccccc'), 'border'),
    };

    expect(isDraftChanged(seed, resetBack)).toBe(false);
    expect(isDraftChanged(pinned, reordered)).toBe(false);
  });

  it('reports a new name or colour', () => {
    expect(isDraftChanged(seed, { ...seed, name: 'Ember' })).toBe(true);
    expect(
      isDraftChanged(seed, { ...seed, dark: setRoleColor(seed.dark, 'accent', '#ff0000') }),
    ).toBe(true);
  });
});

describe('themeNameForSave', () => {
  it('names a blank theme "My theme" and numbers it past names already taken', () => {
    expect(themeNameForSave('  ', [])).toBe('My theme');
    expect(themeNameForSave('', [theme('a', 'My theme')])).toBe('My theme 2');
    expect(themeNameForSave('', [theme('a', 'My theme'), theme('b', 'My theme 2')])).toBe(
      'My theme 3',
    );
    expect(themeNameForSave(' Ember ', [theme('a', 'My theme')])).toBe('Ember');
  });

  it('keeps a numbered or copied long name within the stored-name limit', () => {
    const long = 'x'.repeat(MAX_THEME_NAME_LENGTH);
    const numbered = themeNameForSave(long, [theme('a', long)]);
    expect(numbered.length).toBeLessThanOrEqual(MAX_THEME_NAME_LENGTH);
    expect(numbered).not.toBe(long);
    expect(themeNameForSave(`${long} copy`, []).length).toBeLessThanOrEqual(MAX_THEME_NAME_LENGTH);
  });
});

describe('saving', () => {
  const mine = theme('mine', 'Mine');

  it('gives a new theme a free slug id that never collides with a built-in', () => {
    const draft = { ...theme('seed-id', 'Clay'), name: 'Clay' };
    expect(
      themeToSave({ mode: 'create', seed: draft, appearance: 'light' }, draft, [mine]),
    ).toEqual({ ...draft, id: 'clay-2' });
  });

  it('keeps an edited theme id and does not count its own name as a clash', () => {
    const session = { mode: 'edit', editingId: 'mine', seed: mine, appearance: 'dark' } as const;
    expect(themeToSave(session, mine, [mine])).toEqual(mine);
  });

  it('checks names against every other custom theme, never the one being edited', () => {
    const other = theme('other', 'Other');
    const create = { mode: 'create', seed: mine, appearance: 'light' } as const;
    const edit = { mode: 'edit', editingId: 'mine', seed: mine, appearance: 'light' } as const;
    expect(otherThemes(create, [mine, other])).toEqual([mine, other]);
    expect(otherThemes(edit, [mine, other])).toEqual([other]);
  });

  it('replaces an edited theme in place and appends a new one', () => {
    const other = theme('other', 'Other');
    const renamed = { ...mine, name: 'Mine v2' };
    expect(upsertTheme([mine, other], renamed)).toEqual([renamed, other]);
    expect(upsertTheme([other], mine)).toEqual([other, mine]);
  });
});
