import { create } from 'zustand';
import type { PastedTextFile } from '../../hooks/use-pasted-text-files';
import { appendDraftPastedText } from '../drafts';

/** The draft slot a file was dropped into. `isReady` false sends a chip to storage instead. */
export type PastedChipTarget = { key: string; newChat: boolean; isReady?: () => boolean };

/** Returns true when it took the chip into a live composer. */
export type PastedChipSink = (chip: PastedTextFile) => boolean;

// A file copy outlives its composer, so the chip is routed by slot, not by the hook that started it.
// Two panes can show one sub-chat, so a slot can have several live composers at once.
const sinks = new Map<string, PastedChipSink[]>();
const useInFlight = create<Record<string, number>>(() => ({}));

export function registerPastedChipSink(key: string, sink: PastedChipSink): () => void {
  sinks.set(key, [...(sinks.get(key) ?? []), sink]);
  return () => {
    const rest = (sinks.get(key) ?? []).filter((s) => s !== sink);
    if (rest.length > 0) sinks.set(key, rest);
    else sinks.delete(key);
  };
}

/** The composer that started the copy takes the chip if it still shows that slot, else the newest
 *  one that does; with none ready, it is merged into storage. */
export function deliverPastedChip(
  target: PastedChipTarget,
  chip: PastedTextFile,
  subChatId: string,
  origin?: PastedChipSink,
): void {
  const live = [...(sinks.get(target.key) ?? [])].reverse();
  const order =
    origin && live.includes(origin) ? [origin, ...live.filter((s) => s !== origin)] : live;
  if (order.some((sink) => sink(chip))) return;
  appendDraftPastedText(target.key, chip, target.newChat ? subChatId : undefined);
}

function bumpInFlight(key: string, by: number): void {
  useInFlight.setState((counts) => {
    const { [key]: current = 0, ...rest } = counts;
    return current + by > 0 ? { ...rest, [key]: current + by } : rest;
  }, true);
}

/** Counts a copy toward its slot until the returned function runs; a null slot counts nothing. */
export function beginPastedCopy(key: string | null): () => void {
  if (!key) return () => undefined;
  bumpInFlight(key, 1);
  return () => bumpInFlight(key, -1);
}

/** True while any copy into `key` is running, including one started by a composer since gone. */
export function usePastedCopyInFlight(key: string | null): boolean {
  return useInFlight((counts) => (key ? key in counts : false));
}
