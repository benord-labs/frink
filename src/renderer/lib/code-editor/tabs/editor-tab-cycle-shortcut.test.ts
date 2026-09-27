// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { CustomHotkeysConfig } from '@/lib/hotkeys';
import { getEditorTabCycleDirection } from './editor-tab-cycle-shortcut';

type Ev = Parameters<typeof getEditorTabCycleDirection>[0];

function ev(init: Partial<Ev>): Ev {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  };
}

const DEFAULTS: CustomHotkeysConfig = { version: 1, bindings: {} };
const withBindings = (bindings: CustomHotkeysConfig['bindings']): CustomHotkeysConfig => ({
  version: 1,
  bindings,
});

// macOS reports Shift+] as '}' / Shift+[ as '{'
const CMD_SHIFT_NEXT = ev({
  key: '}',
  code: 'BracketRight',
  metaKey: true,
  shiftKey: true,
});
const CMD_SHIFT_PREV = ev({
  key: '{',
  code: 'BracketLeft',
  metaKey: true,
  shiftKey: true,
});
const CTRL_SHIFT_NEXT = ev({
  key: '}',
  code: 'BracketRight',
  ctrlKey: true,
  shiftKey: true,
});
const CTRL_SHIFT_PREV = ev({
  key: '{',
  code: 'BracketLeft',
  ctrlKey: true,
  shiftKey: true,
});

describe('getEditorTabCycleDirection – default bindings', () => {
  it('matches Cmd+Shift+]/[ on macOS', () => {
    expect(getEditorTabCycleDirection(CMD_SHIFT_NEXT, DEFAULTS, true)).toBe(1);
    expect(getEditorTabCycleDirection(CMD_SHIFT_PREV, DEFAULTS, true)).toBe(-1);
  });

  it('matches by physical key when the layout reports an unshifted bracket', () => {
    const e = ev({
      key: ']',
      code: 'BracketRight',
      metaKey: true,
      shiftKey: true,
    });
    expect(getEditorTabCycleDirection(e, DEFAULTS, true)).toBe(1);
  });

  it('matches Ctrl+Shift+]/[ on Windows/Linux (cmd maps to ctrl)', () => {
    expect(getEditorTabCycleDirection(CTRL_SHIFT_NEXT, DEFAULTS, false)).toBe(1);
    expect(getEditorTabCycleDirection(CTRL_SHIFT_PREV, DEFAULTS, false)).toBe(-1);
  });

  it('does not match the Meta/Win key on Windows/Linux', () => {
    expect(getEditorTabCycleDirection(CMD_SHIFT_NEXT, DEFAULTS, false)).toBeNull();
  });

  it('does not match Ctrl on macOS for a cmd binding', () => {
    expect(getEditorTabCycleDirection(CTRL_SHIFT_NEXT, DEFAULTS, true)).toBeNull();
  });

  it('requires shift and rejects extra modifiers', () => {
    const noShift = ev({ key: ']', code: 'BracketRight', metaKey: true });
    const extraAlt = ev({
      key: '}',
      code: 'BracketRight',
      metaKey: true,
      shiftKey: true,
      altKey: true,
    });
    expect(getEditorTabCycleDirection(noShift, DEFAULTS, true)).toBeNull();
    expect(getEditorTabCycleDirection(extraAlt, DEFAULTS, true)).toBeNull();
  });

  it('ignores unrelated shortcuts', () => {
    const cmdShiftI = ev({
      key: 'I',
      code: 'KeyI',
      metaKey: true,
      shiftKey: true,
    });
    expect(getEditorTabCycleDirection(cmdShiftI, DEFAULTS, true)).toBeNull();
  });
});

describe('getEditorTabCycleDirection – custom bindings', () => {
  const custom = withBindings({
    'next-pane-group': 'cmd+opt+l',
    'prev-pane-group': 'cmd+opt+h',
  });

  it('matches the custom combo', () => {
    // macOS Option+L yields '¬' — must match by physical code
    const next = ev({ key: '¬', code: 'KeyL', metaKey: true, altKey: true });
    const prev = ev({ key: '˙', code: 'KeyH', metaKey: true, altKey: true });
    expect(getEditorTabCycleDirection(next, custom, true)).toBe(1);
    expect(getEditorTabCycleDirection(prev, custom, true)).toBe(-1);
  });

  it('maps a custom cmd binding to ctrl on Windows/Linux', () => {
    const next = ev({ key: 'l', code: 'KeyL', ctrlKey: true, altKey: true });
    expect(getEditorTabCycleDirection(next, custom, false)).toBe(1);
  });

  it('honours a ctrl binding recorded natively on Windows/Linux', () => {
    const cfg = withBindings({ 'next-pane-group': 'ctrl+alt+l' });
    const next = ev({ key: 'l', code: 'KeyL', ctrlKey: true, altKey: true });
    expect(getEditorTabCycleDirection(next, cfg, false)).toBe(1);
  });

  it('stops matching the old default once rebound (stale-binding regression)', () => {
    expect(getEditorTabCycleDirection(CMD_SHIFT_NEXT, custom, true)).toBeNull();
    expect(getEditorTabCycleDirection(CMD_SHIFT_PREV, custom, true)).toBeNull();
    expect(getEditorTabCycleDirection(CTRL_SHIFT_NEXT, custom, false)).toBeNull();
  });

  it('keeps the default for the direction that was not rebound', () => {
    const cfg = withBindings({ 'next-pane-group': 'cmd+opt+l' });
    expect(getEditorTabCycleDirection(CMD_SHIFT_PREV, cfg, true)).toBe(-1);
    expect(getEditorTabCycleDirection(CMD_SHIFT_NEXT, cfg, true)).toBeNull();
  });

  it('swapped bindings follow the configuration, not the key', () => {
    const cfg = withBindings({
      'next-pane-group': 'cmd+shift+[',
      'prev-pane-group': 'cmd+shift+]',
    });
    expect(getEditorTabCycleDirection(CMD_SHIFT_PREV, cfg, true)).toBe(1);
    expect(getEditorTabCycleDirection(CMD_SHIFT_NEXT, cfg, true)).toBe(-1);
  });

  it('prefers next when both directions share the same combo', () => {
    const cfg = withBindings({
      'next-pane-group': 'cmd+shift+]',
      'prev-pane-group': 'cmd+shift+]',
    });
    expect(getEditorTabCycleDirection(CMD_SHIFT_NEXT, cfg, true)).toBe(1);
  });
});

describe('getEditorTabCycleDirection – unbound and degenerate bindings', () => {
  it('returns null for an explicitly unbound action (null)', () => {
    const cfg = withBindings({
      'next-pane-group': null,
      'prev-pane-group': null,
    });
    expect(getEditorTabCycleDirection(CMD_SHIFT_NEXT, cfg, true)).toBeNull();
    expect(getEditorTabCycleDirection(CMD_SHIFT_PREV, cfg, true)).toBeNull();
  });

  it('returns null for an empty-string binding', () => {
    const cfg = withBindings({ 'next-pane-group': '' });
    expect(getEditorTabCycleDirection(CMD_SHIFT_NEXT, cfg, true)).toBeNull();
    expect(getEditorTabCycleDirection(ev({ key: '' }), cfg, true)).toBeNull();
  });

  it('never hijacks modifier-less bindings while typing in the editor', () => {
    // The recorder allows bare '/', '?', 'Tab', 'Enter'; the global manager skips
    // those in text inputs (Monaco is a textarea), so the panel fallback must too.
    const cfg = withBindings({
      'next-pane-group': 'tab',
      'prev-pane-group': '/',
    });
    expect(getEditorTabCycleDirection(ev({ key: 'Tab', code: 'Tab' }), cfg, true)).toBeNull();
    expect(getEditorTabCycleDirection(ev({ key: '/', code: 'Slash' }), cfg, false)).toBeNull();
  });

  it('matches a mixed-case stored binding', () => {
    const cfg = withBindings({ 'next-pane-group': 'Cmd+Shift+]' });
    expect(getEditorTabCycleDirection(CMD_SHIFT_NEXT, cfg, true)).toBe(1);
    expect(getEditorTabCycleDirection(CTRL_SHIFT_NEXT, cfg, false)).toBe(1);
  });
});
