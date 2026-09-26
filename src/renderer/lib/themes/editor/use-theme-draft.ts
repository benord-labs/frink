import { useSetAtom } from 'jotai';
import { useCallback, useState } from 'react';
import type { Appearance, Role } from '../palette/roles';
import { editRole, isDraftChanged, resetDraftRole, startDraft } from './draft';
import { type ThemeEditorSession, themeEditorDraftNameAtom } from './editor-atoms';

/** The editor's working copy of a theme: both halves, with one on screen. */
export function useThemeDraft(session: ThemeEditorSession) {
  const [draft, setDraft] = useState(() => startDraft(session));
  const [appearance, setAppearance] = useState<Appearance>(session.appearance);
  const setDraftName = useSetAtom(themeEditorDraftNameAtom);

  // Stable per half, so memoised colour rows skip re-rendering while another row changes.
  const changeRole = useCallback(
    (role: Role, hex: string) => setDraft((current) => editRole(current, appearance, role, hex)),
    [appearance],
  );
  const resetRole = useCallback(
    (role: Role) => setDraft((current) => resetDraftRole(current, appearance, role)),
    [appearance],
  );
  const rename = useCallback(
    (name: string) => {
      setDraft((current) => ({ ...current, theme: { ...current.theme, name } }));
      setDraftName(name);
    },
    [setDraftName],
  );
  // "Undo my changes": both halves and the name go back to where the session started.
  const revert = useCallback(() => {
    setDraft(startDraft(session));
    setDraftName(session.seed.name);
  }, [session, setDraftName]);

  return {
    draft: draft.theme,
    half: draft.theme[appearance],
    /** Overrides in this half still inherited from the seed rather than set by the user. */
    inherited: draft.inherited[appearance],
    appearance,
    setAppearance,
    rename,
    revert,
    changeRole,
    resetRole,
    changed: isDraftChanged(session.seed, draft.theme),
  };
}

export type ThemeDraft = ReturnType<typeof useThemeDraft>;
