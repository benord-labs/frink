import { type Atom, useAtomValue } from 'jotai';
import { type RefObject, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { agentsSidebarWidthAtom } from '@/lib/atoms';
import { cancelGlide } from '../glide';
import { themeEditorSessionAtom } from './editor-atoms';

/** The dock: 360px of panel plus its inset (`w-93`). */
const DOCK_PX = 372;
/** The chat's own 350px content floor (agents-content, active-chat) plus the row's inset gaps. */
const CHAT_FLOOR_PX = 366;

/** The dock's width, never leaving the chat under its floor. */
export const DOCK_WIDTH_CLASS = 'w-93 max-w-[calc(100vw-366px)]';

const GLIDE = { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' };

const YIELD = {
  none: { files: 'contents', sidebar: '' },
  files: { files: 'hidden', sidebar: '' },
  both: { files: 'hidden', sidebar: 'hidden' },
};

function onResize(change: () => void): () => void {
  window.addEventListener('resize', change);
  return () => window.removeEventListener('resize', change);
}

/**
 * Glides the dock between its closed and open widths, so the chat reflows smoothly. Web
 * Animations, not a CSS transition: opening paints the draft, which turns transitions off.
 */
export function useDockGlide(open: boolean): RefObject<HTMLDivElement | null> {
  const dock = useRef<HTMLDivElement>(null);
  const width = useRef(0);
  const glide = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = dock.current;
    if (!element) return;
    const now = () => element.getBoundingClientRect().width;
    const from = cancelGlide(glide.current, now, width.current);
    // The end is read once any running glide is cancelled.
    width.current = now();
    if (from === width.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    glide.current = element.animate({ width: [`${from}px`, `${width.current}px`] }, GLIDE);
  }, [open]);
  return dock;
}

/** Classes that fold the side panels away (file tree first) while the editor is docked, once
 * their widths would squeeze the chat below its floor; widths, not breakpoints, as both resize. */
export function useThemeEditorYield(
  sidebarOpen: boolean,
  filesWidthAtom: Atom<number>,
): (typeof YIELD)['none'] & { inset: boolean } {
  const open = useAtomValue(themeEditorSessionAtom) !== null;
  const sidebar = useAtomValue(agentsSidebarWidthAtom);
  const files = useAtomValue(filesWidthAtom);
  const tier = useSyncExternalStore(onResize, () => {
    const room = window.innerWidth - DOCK_PX - CHAT_FLOOR_PX;
    if (!open || room >= (sidebarOpen ? sidebar : 0) + files) return 'none';
    return room >= sidebar ? 'files' : 'both';
  });
  // With no side panel left showing, the main pane meets the window edge: it drops its inset.
  return { ...YIELD[tier], inset: tier === 'none' || (tier === 'files' && sidebarOpen) };
}
