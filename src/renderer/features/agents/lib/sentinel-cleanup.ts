import { appStore } from '../../../lib/jotai-store';
import {
  activeTerminalIdAtom,
  terminalSidebarOpenAtomFamily,
  terminalsAtom,
} from '../../terminal/atoms';
import type { TerminalInstance } from '../../terminal/types';

/**
 * Cleans up all sentinel-keyed state from Jotai atoms and localStorage.
 * Called on both component unmount and successful chat creation.
 */
export function cleanupSentinelState(terminalId: string): void {
  appStore.set(terminalSidebarOpenAtomFamily(terminalId), false);
  appStore.set(terminalsAtom, (prev: Record<string, TerminalInstance[]>) => {
    const { [terminalId]: _, ...rest } = prev;
    return rest;
  });
  appStore.set(activeTerminalIdAtom, (prev: Record<string, string | null>) => {
    const { [terminalId]: _, ...rest } = prev;
    return rest;
  });
}
