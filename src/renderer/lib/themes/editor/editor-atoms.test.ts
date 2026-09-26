// @vitest-environment happy-dom
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { activeOverlayAtom } from '../../atoms/agent-navigation-atoms';
import type { ThemeDefinition } from '../palette/theme-schema';
import {
  closeThemeEditorAtom,
  openThemeEditorAtom,
  themeEditorDraftNameAtom,
  themeEditorSelectedRoleAtom,
  themeEditorSessionAtom,
  themeEditorShowAllAtom,
} from './editor-atoms';

const SEED: ThemeDefinition = {
  id: 'clay-copy',
  name: 'Clay copy',
  light: { background: '#faf9f5', accent: '#b05230', syntax: 'github-light' },
  dark: { background: '#262624', accent: '#d97857', syntax: 'github-dark' },
};

describe('theme editor session', () => {
  it('closes Settings on open so the workspace becomes the preview', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'settings');
    store.set(openThemeEditorAtom, { mode: 'create', seed: SEED, appearance: 'dark' });
    expect(store.get(activeOverlayAtom)).toBeNull();
    expect(store.get(themeEditorSessionAtom)).toMatchObject({ mode: 'create', appearance: 'dark' });

    store.set(themeEditorSelectedRoleAtom, 'text');
    store.set(closeThemeEditorAtom);
    expect(store.get(themeEditorSessionAtom)).toBeNull();
    expect(store.get(themeEditorSelectedRoleAtom)).toBeNull();
  });

  it('turns All colors on for a picked role and clears editor state on close', () => {
    const store = createStore();
    store.set(openThemeEditorAtom, { mode: 'create', seed: SEED, appearance: 'dark' });
    expect(store.get(themeEditorDraftNameAtom)).toBe('Clay copy');
    expect(store.get(themeEditorShowAllAtom)).toBe(false);

    store.set(themeEditorSelectedRoleAtom, 'text');
    expect(store.get(themeEditorShowAllAtom)).toBe(true);
    store.set(themeEditorSelectedRoleAtom, null);
    expect(store.get(themeEditorShowAllAtom)).toBe(true);

    store.set(closeThemeEditorAtom);
    expect(store.get(themeEditorShowAllAtom)).toBe(false);
    expect(store.get(themeEditorDraftNameAtom)).toBe('');
  });
});
