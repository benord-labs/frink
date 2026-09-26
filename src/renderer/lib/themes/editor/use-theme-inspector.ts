import { useAtom, useSetAtom } from 'jotai';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { ROLE_LABELS, type Role } from '../palette/roles';
import { themeEditorSelectedRoleAtom } from './editor-atoms';
import {
  inspectHover,
  inspectRoleAt,
  isEditorElement,
  roleUsage,
  uninspectableHost,
} from './inspector';
import { clearHoverBox, largestOnScreen, showHoverBox, showSpotlight } from './spotlight';

const ARMED_STATUS = 'Click anything in Frink · Esc to stop';
const UNINSPECTABLE_STATUS = "The terminal and code editor can't be inspected.";
const NO_ROLE_STATUS = "That spot doesn't use a theme color.";
// Rows spotlight after the pointer settles: each spotlight probes every element on screen.
const HOVER_SETTLE_MS = 120;

export type ThemeInspector = {
  armed: boolean;
  /** One line for the panel header; null when Inspect has nothing to say. */
  status: string | null;
  /** The spotlit role and how many places on screen show it. */
  usage: Usage | null;
  toggle: () => void;
  /** Drops the picked role and its spotlight. */
  clear: () => void;
  /** Spotlights a role while its row is hovered; null when the pointer leaves. */
  hover: (role: Role | null) => void;
};

type Usage = { role: Role; count: number };
type Pick = { role: Role; element: Element };

type ArmedHandlers = {
  pick: (role: Role, element: Element) => void;
  disarm: () => void;
  stop: () => void;
  notice: (status: string) => void;
};

/** The event's target when it is app content rather than the editor's own UI. */
function appTarget(event: Event): Element | null {
  return event.target instanceof Element && !isEditorElement(event.target) ? event.target : null;
}

/** Stops an app event from reaching the app; returns its target, or null when it isn't one. */
function swallow(event: Event): Element | null {
  const target = appTarget(event);
  if (target) {
    event.preventDefault();
    event.stopPropagation();
  }
  return target;
}

/** Hover reads classes and computed colours; the exact probe waits for a click. */
function hover(event: PointerEvent): void {
  const target = appTarget(event);
  if (!target) {
    clearHoverBox();
    return;
  }
  const host = uninspectableHost(target);
  if (host) {
    showHoverBox(host, "Can't be inspected");
    return;
  }
  const { element, role } = inspectHover(target);
  showHoverBox(element, role ? ROLE_LABELS[role] : 'Click to inspect');
}

/** Lifts the native `title` tooltip off a hovered element; returns its restore. */
function hideTitle(element: Element | null): () => void {
  const titled = element?.closest('[title]');
  const title = titled?.getAttribute('title');
  if (!titled || title == null) return () => {};
  titled.removeAttribute('title');
  return () => titled.setAttribute('title', title);
}

/** Radix tooltips open on pointermove; muting it leaves the inspect label as the only one. */
function muteAppHover(event: PointerEvent): void {
  if (event.buttons === 0 && appTarget(event)) event.stopPropagation();
}

function leaveWindow(event: PointerEvent): void {
  if (!event.relatedTarget) clearHoverBox();
}

/** Swallows the release and click of the press that picked, even once Inspect has let go. */
function swallowRestOfPress(): void {
  const press = new AbortController();
  const options = { capture: true, signal: press.signal };
  document.addEventListener('pointerup', swallow, options);
  document.addEventListener(
    'click',
    (event) => {
      if (event.detail !== 0) swallow(event);
      press.abort();
    },
    options,
  );
  // A press that ends with no click (a Ctrl+click, a drag) lets go at the next press.
  document.addEventListener('pointerdown', () => press.abort(), options);
}

/** Capture-phase listeners while armed, ahead of every app handler. Returns their removal. */
function listenArmed({ pick, disarm, stop, notice }: ArmedHandlers): () => void {
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  let restoreTitle = () => {};
  const onPointerOver = (event: PointerEvent) => {
    restoreTitle();
    restoreTitle = hideTitle(appTarget(event));
    hover(event);
  };
  const onPointerDown = (event: PointerEvent) => {
    const target = event.button === 0 ? swallow(event) : null;
    if (!target) return;
    const uninspectable = uninspectableHost(target) !== null;
    const hit = uninspectable ? null : inspectRoleAt(target);
    if (!hit) {
      notice(uninspectable ? UNINSPECTABLE_STATUS : NO_ROLE_STATUS);
      return;
    }
    clearHoverBox();
    pick(hit.role, hit.element);
    swallowRestOfPress();
    disarm();
  };
  // A click with no pointer behind it (detail 0: Enter/Space, a screen reader) stays with the app.
  const onClick = (event: MouseEvent) => {
    if (event.detail !== 0) swallow(event);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  document.addEventListener('pointerover', onPointerOver, options);
  document.addEventListener('pointermove', muteAppHover, options);
  document.addEventListener('pointerout', leaveWindow, options);
  document.addEventListener('pointerdown', onPointerDown, options);
  document.addEventListener('pointerup', swallow, options);
  document.addEventListener('click', onClick, options);
  document.addEventListener('keydown', onKeyDown, options);
  document.addEventListener('scroll', clearHoverBox, options);
  return () => {
    listeners.abort();
    restoreTitle();
    clearHoverBox();
  };
}

function usageStatus({ role, count }: Usage): string {
  const where =
    count === 0
      ? 'Not on screen right now'
      : `Shown in ${count} ${count === 1 ? 'place' : 'places'} on screen`;
  return `${ROLE_LABELS[role]} · ${where}`;
}

/** Armed: the pick prompt or its last notice. Otherwise a picked role's usage, not a hovered one. */
function inspectorStatus(
  armed: boolean,
  notice: string | null,
  shown: Usage | null,
  picked: Role | null,
): string | null {
  if (armed) return notice ?? ARMED_STATUS;
  return shown && shown.role === picked ? usageStatus(shown) : null;
}

/** Rings the clicked element while it shows, else `role`'s largest use. Returns the removal. */
function spotlightRole(
  role: Role,
  picked: Pick | null,
  report: (usage: Usage) => void,
  dismiss: () => void,
): () => void {
  const clicked = picked?.role === role ? largestOnScreen([picked.element]) : null;
  const matches = roleUsage(role, clicked);
  report({ role, count: matches.length });
  const target = clicked ?? largestOnScreen(matches);
  const hideSpotlight = target ? showSpotlight(target, ROLE_LABELS[role]) : null;
  // Using the app dismisses it; the editor stays usable underneath.
  const onPointerDown = (event: PointerEvent) => {
    if (appTarget(event)) dismiss();
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    hideSpotlight?.();
  };
}

/** The hovered row's role, set once the pointer settles so a sweep down the list spotlights once. */
function useSettledHover(): [Role | null, (role: Role | null) => void, () => void] {
  const [hovered, setHovered] = useState<Role | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hover = useCallback((role: Role | null) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(role), HOVER_SETTLE_MS);
  }, []);
  const endHover = useCallback(() => {
    clearTimeout(timer.current);
    setHovered(null);
  }, []);
  return [hovered, hover, endHover];
}

/** Inspect for the theme editor: arm, click anything, and the editor selects and spotlights the
 * role painting it; hovering a row spotlights its role. `suspended` (app covered) pauses both. */
/** While `listening`, a click picks a role; returns the element the last pick resolved to. */
function useArmedPick(
  listening: boolean,
  setArmed: (armed: boolean) => void,
  setNotice: (notice: string | null) => void,
): RefObject<Pick | null> {
  const [selectedRole, setSelectedRole] = useAtom(themeEditorSelectedRoleAtom);
  const picked = useRef<Pick | null>(null);
  useEffect(() => {
    if (!listening) return;
    return listenArmed({
      pick: (role, element) => {
        picked.current = { role, element };
        setSelectedRole(role);
      },
      disarm: () => setArmed(false),
      stop: () => {
        setArmed(false);
        setSelectedRole(null);
      },
      notice: setNotice,
    });
  }, [listening, setArmed, setNotice, setSelectedRole]);
  // A pick lasts only as long as its selection; runs before the spotlight reads it.
  useEffect(() => {
    if (picked.current?.role !== selectedRole) picked.current = null;
  }, [selectedRole]);
  return picked;
}

/** Spotlights `spotlit`; a click in the app ends a row's preview, or else drops the selection. */
function useRoleSpotlight(
  spotlit: Role | null,
  picked: RefObject<Pick | null>,
  endPreview: (() => void) | null,
): Usage | null {
  const setSelectedRole = useSetAtom(themeEditorSelectedRoleAtom);
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    if (!spotlit) return;
    const dismiss = endPreview ?? (() => setSelectedRole(null));
    return spotlightRole(spotlit, picked.current, setUsage, dismiss);
  }, [spotlit, picked, endPreview, setSelectedRole]);
  return spotlit && usage?.role === spotlit ? usage : null;
}

export function useThemeInspector(suspended: boolean): ThemeInspector {
  const [armed, setArmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [hovered, hover, endHover] = useSettledHover();
  const [selectedRole, setSelectedRole] = useAtom(themeEditorSelectedRoleAtom);
  const picked = useArmedPick(armed && !suspended, setArmed, setNotice);
  // Picking needs the unobscured app, so the spotlight waits while armed.
  const spotlit = armed || suspended ? null : (hovered ?? selectedRole);
  const shown = useRoleSpotlight(spotlit, picked, hovered === null ? null : endHover);

  return {
    armed,
    status: inspectorStatus(armed, notice, shown, hovered ? null : selectedRole),
    usage: shown,
    toggle: () => {
      setNotice(null);
      setArmed((current) => !current);
    },
    clear: () => setSelectedRole(null),
    hover,
  };
}
