import type { UIMessageChunk } from '../../../claude/types';

/** A Codex context compaction on the shared compact line: live while open, one saved line once
 * settled. Frink never asks Codex to compact, so each one it sees is automatic. */
export function compactionOpened(id: string): UIMessageChunk[] {
  if (!id) return [];
  return [{ type: 'data-compact', id, transient: true, data: { state: 'input-streaming' } }];
}

export function compactionSettled(id: string): UIMessageChunk[] {
  if (!id) return [];
  return [{ type: 'data-compact', id, data: { state: 'output-available', trigger: 'auto' } }];
}

/** Per turn. A failed compaction ends in an error with no completed item, so the open one is
 * settled as failed just ahead of whichever error ends the turn. */
export function createCompactionFailureSettler(): (chunk: UIMessageChunk) => UIMessageChunk[] {
  let openId: string | null = null;
  return (chunk) => {
    if (chunk.type === 'data-compact') {
      openId = chunk.data.state === 'input-streaming' ? chunk.id : null;
      return [chunk];
    }
    if (chunk.type !== 'error' || !openId) return [chunk];
    const id = openId;
    openId = null;
    return [{ type: 'data-compact', id, data: { state: 'output-error' } }, chunk];
  };
}
