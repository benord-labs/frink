import { z } from 'zod';
import { connectionSchema, type Connection } from './api';
import { NO_COMPUTERS, type Computers } from './computers';

/** The minimal key-value store both SecureStore and sessionStorage provide. */
export type KeyValue = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

// One small index plus one entry per computer keeps every value far below SecureStore's 2 KB cap.
const INDEX = 'frink.mobile.computers.v2';
const entryKey = (deviceId: string) => `frink.mobile.computer.${deviceId}`;
const indexSchema = z.object({ selected: z.string().nullable(), ids: z.array(z.uuid()) });

function parse<T>(schema: z.ZodType<T>, text: string | null): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Reads every paired computer; an unreadable entry is dropped, never fatal. */
export async function readComputers(store: KeyValue): Promise<Computers> {
  const index = parse(indexSchema, await store.get(INDEX));
  if (!index) return NO_COMPUTERS;
  const computers: Connection[] = [];
  for (const id of index.ids) {
    const computer = parse(connectionSchema, await store.get(entryKey(id)));
    if (computer?.deviceId === id) computers.push(computer);
  }
  const selected = computers.some((c) => c.deviceId === index.selected)
    ? index.selected
    : (computers[0]?.deviceId ?? null);
  return { computers, selected };
}

/**
 * Writes every entry before the index and deletes dropped entries after it, so an interrupted or
 * failed save can leave a stray entry but never an index naming a computer that isn't stored. A
 * save succeeds once its index is written.
 */
export async function saveComputers(store: KeyValue, previous: Computers, next: Computers) {
  const ids = next.computers.map((c) => c.deviceId);
  for (const computer of next.computers)
    await store.set(entryKey(computer.deviceId), JSON.stringify(computer));
  await store.set(INDEX, JSON.stringify({ selected: next.selected, ids }));
  // The index is the record now; a dropped entry that fails to delete is only a stray.
  for (const computer of previous.computers)
    if (!ids.includes(computer.deviceId))
      await store.remove(entryKey(computer.deviceId)).catch(() => undefined);
}

/**
 * Saves states one at a time; deletions are diffed against the last state that was fully stored,
 * so a failed save is retried by the next one instead of being mistaken for stored.
 */
export function computerSaver(store: KeyValue, stored: Computers) {
  let last = stored;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    /** `next` may be read when this save's turn comes, so a retry stores the latest state. */
    save(state: Computers | (() => Computers)): Promise<void> {
      const run = queue.then(async () => {
        const next = typeof state === 'function' ? state() : state;
        await saveComputers(store, last, next);
        last = next;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    /** The last state known to be stored in full. */
    stored: () => last,
  };
}
