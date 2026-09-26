import { SIDEBAR_PANEL_SEARCH_INPUT_CLASS } from '../sidebar/panel-search-input-class';
import { panelTabButtonClass } from '../sidebar/panel-tab-button-class';

/** Active / inactive tab — matches unified sidebar list emphasis (no primary pill). */
export function filesSidebarTabButtonClass(isActive: boolean): string {
  return panelTabButtonClass(isActive, 'xs');
}

export const FILES_SIDEBAR_SEARCH_INPUT_CLASS = SIDEBAR_PANEL_SEARCH_INPUT_CLASS;
