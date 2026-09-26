import { Mutex } from 'async-mutex';

/**
 * Per-sub-chat async mutex registry.
 *
 * Phase 1 local-first migration: the messages JSON column is updated via
 * read-modify-write under the hood (`UPDATE sub_chats SET messages = ?`). With two
 * concurrent streams (e.g. an active chat + a sub-agent firing in parallel), an
 * unguarded RMW would lose chunks. SQLite's table-level lock alone doesn't cover
 * the read-then-write boundary across two awaits.
 *
 * `async-mutex` is already a project dependency (see src/main/lib/mcp/config.ts).
 * We keep one Mutex per sub-chat ID; entries are never evicted because per-user
 * sub-chat counts are bounded (hundreds, not millions) and each Mutex is ~tens of
 * bytes — keeping the implementation simple beats premature eviction.
 */
// The generation rides the same entry: same key, same lifetime, same bounded rationale.
type SubChatWrites = { mutex: Mutex; generation: number };
const writes = new Map<string, SubChatWrites>();

function writesFor(subChatId: string): SubChatWrites {
  let entry = writes.get(subChatId);
  if (!entry) {
    entry = { mutex: new Mutex(), generation: 0 };
    writes.set(subChatId, entry);
  }
  return entry;
}

export async function withSubChatLock<T>(subChatId: string, fn: () => Promise<T>): Promise<T> {
  return writesFor(subChatId).mutex.runExclusive(fn);
}

/** Bumped by a wholesale transcript replacement; see `upsertAssistantMessage` for the reader. */
export function getWriteGeneration(subChatId: string): number {
  return writesFor(subChatId).generation;
}

/** Call under `withSubChatLock` — every reader compares against a value captured outside it. */
export function bumpWriteGeneration(subChatId: string): void {
  writesFor(subChatId).generation += 1;
}

/** True when a replacement landed since `generation` was captured. Pure — every recovery seed
 * reads it — and must be evaluated inside the caller's own lock. */
export function isStaleWrite(subChatId: string, generation: number | undefined): boolean {
  return generation !== undefined && getWriteGeneration(subChatId) !== generation;
}

/**
 * Test-only: clear all write state (so vitest runs don't leak state across tests).
 *
 * Phase 1.5 fix E: guard against accidental production import. Calling this while
 * any in-flight callback is queued silently breaks mutual exclusion (subsequent
 * calls create a fresh Mutex, dropping the queue). Vitest sets NODE_ENV=test;
 * any other environment hitting this is a misuse worth surfacing loudly.
 */
export function __resetSubChatLocks(): void {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    throw new Error(
      '__resetSubChatLocks is test-only — calling it in non-test code silently breaks the per-sub-chat write contract',
    );
  }
  writes.clear();
}
