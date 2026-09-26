import { atom } from 'jotai';

/** The element right of the main pane that a single chat's side panels render into. */
export const sidePanelDockAtom = atom<HTMLElement | null>(null);
