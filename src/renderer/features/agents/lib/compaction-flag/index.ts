import { atom } from 'jotai';
import { appStore } from '../../../../lib/jotai-store';
import { compactingForSubChatAtomFamily, compactingSubChatsAtom } from '../../atoms';

/**
 * Single writer for the per-sub-chat compaction flag.
 *
 * A run that dies mid-compaction emits no settling chunk — the lifecycle closes only on the
 * boundary or an explicit failure — so every path that ends a turn clears the flag here. Left set,
 * it outlives its turn and the NEXT turn's pending card claims the chat is compacting while the
 * model is really answering.
 */
export function setCompacting(subChatId: string, compacting: boolean): void {
  // Updater rather than read-then-write: clearing runs on every turn end, and returning the same
  // Set when nothing changed lets jotai skip re-rendering every pane subscribed to it.
  appStore.set(compactingSubChatsAtom, (current) => {
    if (current.has(subChatId) === compacting) return current;
    const next = new Set(current);
    if (compacting) next.add(subChatId);
    else next.delete(subChatId);
    return next;
  });
}

/** Stand-in for the panes that opt out below. */
const NOT_COMPACTING = atom(false);

/**
 * Which compaction atom a pane should subscribe to.
 *
 * Every message group in a sub-chat shares one flag, so subscribing them all would re-render the
 * whole transcript on a single compaction toggle. Only the pane that can actually render the card
 * takes the live value; the rest hold a constant and never wake.
 */
export function compactingAtomFor(subChatId: string, canShowCard: boolean) {
  return canShowCard ? compactingForSubChatAtomFamily(subChatId) : NOT_COMPACTING;
}
