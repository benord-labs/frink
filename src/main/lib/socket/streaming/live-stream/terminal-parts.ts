import { isStaleWrite } from '../../../db/repos/sub-chat-mutex';

type FencedRecord = { subChatId: string; generation?: number };

/** Parts may be projected to the renderer only while the transcript they belong to still exists —
 * otherwise the seed re-appends a rolled-away message. No fence at all is refused, not assumed. */
export function keepsProjectedParts(record: FencedRecord): boolean {
  return record.generation !== undefined && !isStaleWrite(record.subChatId, record.generation);
}

/** A terminal's parts exist to paint what SQLite would not keep, so only a non-durable one has any. */
export function keepsTerminalParts(
  record: FencedRecord & { terminalDurability?: { durability: string } },
): boolean {
  return record.terminalDurability?.durability === 'non-durable' && keepsProjectedParts(record);
}
