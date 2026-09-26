import log from 'electron-log';
import type { NodeSqliteDatabase } from './node-sqlite-driver';

/**
 * One-shot: rewrite persisted tool parts from `'result'` (AI SDK v4) to `'output-available'`
 * (v5+), and drop the now-redundant `output` -> `result` mirror. Runs at startup, gated by
 * `PRAGMA user_version` — see `db/index.ts` for why this must run after the other sweeps there.
 */

const V4_TERMINAL_STATE = 'result';
const SDK_TERMINAL_STATE = 'output-available';

/** One-shot data normalizations, tracked in `PRAGMA user_version`. See `db/index.ts`. */
const TOOL_PART_STATE_USER_VERSION = 3;

type JsonRecord = Record<string, unknown>;

export type NormalizeStats = { states: number; mirrors: number };

function normalizePart(part: JsonRecord, stats: NormalizeStats): boolean {
  let changed = false;

  if (part.state === V4_TERMINAL_STATE) {
    part.state = SDK_TERMINAL_STATE;
    stats.states++;
    changed = true;
  }

  // `result` survives when there is no `output` to replace it — the AskUserQuestion closed
  // reason ("Skipped", "Timed out") is a bare string with nowhere else to live.
  if ('result' in part && part.output !== undefined) {
    delete part.result;
    stats.mirrors++;
    changed = true;
  }

  return changed;
}

/** Returns the rewritten JSON, or null when nothing changed. Throws on unparseable input. */
export function normalizeMessagesJson(raw: string, stats: NormalizeStats): string | null {
  const messages = JSON.parse(raw) as unknown;
  if (!Array.isArray(messages)) return null;

  let changed = false;
  for (const message of messages) {
    const parts = (message as JsonRecord | null)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part && typeof part === 'object' && normalizePart(part as JsonRecord, stats)) {
        changed = true;
      }
    }
  }

  return changed ? JSON.stringify(messages) : null;
}

function mayNeedNormalizing(raw: string): boolean {
  return raw.includes(`"state":"${V4_TERMINAL_STATE}"`) || raw.includes('"result":');
}

export function normalizeToolPartStates(dbInstance: NodeSqliteDatabase): void {
  const currentVersion = (dbInstance.pragma('user_version', { simple: true }) as number) ?? 0;
  if (currentVersion >= TOOL_PART_STATE_USER_VERSION) return;

  const ids = dbInstance.prepare('SELECT id FROM sub_chats').all() as { id: string }[];
  const read = dbInstance.prepare('SELECT messages FROM sub_chats WHERE id = ?');
  // updated_at is intentionally not set — this isn't a user edit, and it orders the chat list.
  const write = dbInstance.prepare('UPDATE sub_chats SET messages = ? WHERE id = ?');

  const stats: NormalizeStats = { states: 0, mirrors: 0 };
  let rewritten = 0;
  let skipped = 0;

  for (const { id } of ids) {
    const row = read.get(id) as { messages: string } | undefined;
    if (!row?.messages || !mayNeedNormalizing(row.messages)) continue;

    let next: string | null;
    try {
      next = normalizeMessagesJson(row.messages, stats);
    } catch (error) {
      // Left byte-identical, not blanked: safeParseMessages degrades unparseable JSON to `[]`.
      skipped++;
      log.warn('[db] tool-part state normalization skipped unparseable sub_chat', id, error);
      continue;
    }

    if (next === null) continue;
    write.run(next, id);
    rewritten++;
  }

  if (rewritten > 0 || skipped > 0) {
    log.info(
      `[db] tool-part states normalized: ${stats.states} states, ${stats.mirrors} redundant result ` +
        `mirrors, across ${rewritten}/${ids.length} sub-chats (${skipped} skipped)`,
    );
  }

  // Only claim the ledger from the version directly below: a sweep above this one can abort
  // without bumping (e.g. the credential sweep, on a missing keyring) so it retries next launch,
  // and bumping unconditionally would retire that retry on its behalf.
  if (currentVersion === TOOL_PART_STATE_USER_VERSION - 1) {
    dbInstance.pragma(`user_version = ${TOOL_PART_STATE_USER_VERSION}`);
  }
}
