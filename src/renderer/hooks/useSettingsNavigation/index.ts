/**
 * Opening the Settings dialog, optionally on a specific tab.
 *
 * Sidebar destinations that are really Settings tabs (Plugins) need the tab set
 * before the dialog opens, or the dialog flashes whichever tab was last active.
 * Keeping both writes here means a caller never has to know that ordering.
 */
import { useSetAtom } from 'jotai';
import { useCallback } from 'react';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  type SettingsTab,
} from '../../lib/atoms';

type SettingsNavigation = {
  /** Open Settings on whichever tab was last active. */
  openSettings: () => void;
  /** Open Settings on a named tab. */
  openSettingsTab: (tab: SettingsTab) => void;
};

export function useSettingsNavigation(): SettingsNavigation {
  const setOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);

  const openSettings = useCallback(() => setOpen(true), [setOpen]);
  const openSettingsTab = useCallback(
    (tab: SettingsTab) => {
      setActiveTab(tab);
      setOpen(true);
    },
    [setActiveTab, setOpen],
  );

  return { openSettings, openSettingsTab };
}
