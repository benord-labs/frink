import { atom, type Setter } from 'jotai';
import { agentsSettingsDialogOpenAtom } from '../../atoms/agent-navigation-atoms';
import type { Appearance, Role } from '../palette/roles';
import type { ThemeDefinition } from '../palette/theme-schema';

/** An open theme editor: what it started from and which half is on screen. */
export type ThemeEditorSession = {
  /** Starting point for the draft; the editor keeps the draft in local state. */
  seed: ThemeDefinition;
  appearance: Appearance;
} & ({ mode: 'create' } | { mode: 'edit'; editingId: string });

export const themeEditorSessionAtom = atom<ThemeEditorSession | null>(null);

/** The draft's name as typed, for pages outside the editor; blank means the seed's name. */
export const themeEditorDraftNameAtom = atom('');

/** The "All colors" switch: whether the editor lists every role. */
export const themeEditorShowAllAtom = atom(false);

const selectedRoleAtom = atom<Role | null>(null);

/**
 * The role the editor highlights and scrolls to. Inspect sets it from a click in the app, which
 * also turns "All colors" on so the picked role is listed.
 */
export const themeEditorSelectedRoleAtom = atom(
  (get) => get(selectedRoleAtom),
  (_get, set, role: Role | null) => {
    set(selectedRoleAtom, role);
    if (role) set(themeEditorShowAllAtom, true);
  },
);

function resetEditorState(set: Setter, session: ThemeEditorSession | null): void {
  set(themeEditorSessionAtom, session);
  set(themeEditorSelectedRoleAtom, null);
  set(themeEditorShowAllAtom, false);
  set(themeEditorDraftNameAtom, session?.seed.name ?? '');
}

/** Opens the editor and closes Settings, so the workspace becomes the live preview. */
export const openThemeEditorAtom = atom(null, (_get, set, session: ThemeEditorSession) => {
  resetEditorState(set, session);
  set(agentsSettingsDialogOpenAtom, false);
});

export const closeThemeEditorAtom = atom(null, (_get, set) => resetEditorState(set, null));
