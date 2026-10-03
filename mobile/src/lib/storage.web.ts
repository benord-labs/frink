import type { Computers } from './computers';
import { computerSaver, readComputers, type KeyValue } from './computer-store';

// Browser previews keep pairings for this tab only (sessionStorage), never across sessions.
const tab: KeyValue = {
  get: async (key) => sessionStorage.getItem(key),
  set: async (key, value) => sessionStorage.setItem(key, value),
  remove: async (key) => sessionStorage.removeItem(key),
};

export function readSavedComputers(): Promise<Computers> {
  return readComputers(tab);
}
/** Saves later states of the computers just read, one at a time. */
export function savingComputers(stored: Computers) {
  return computerSaver(tab, stored);
}
