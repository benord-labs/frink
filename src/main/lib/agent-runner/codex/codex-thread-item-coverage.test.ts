/**
 * Guards the curation half of the ThreadItem denylist: every variant upstream ships at the pinned
 * Codex version must be deliberately classified, not left to the synthetic-card fallback.
 */

import { describe, expect, it } from 'vitest';
import threadItems from '../../../../../patches/codex/thread-item-variants.json';
import { mapNotificationToChunks } from './codex-events';

/** A card named `codex_<type>` is the denylist's visible fallback for a variant nobody classified. */
function syntheticNames(method: string, type: string): string[] {
  return mapNotificationToChunks(method, { item: { type, id: 's1' } })
    .map((chunk) => ('toolName' in chunk ? chunk.toolName : ''))
    .filter((name) => name.startsWith('codex_'));
}

describe('ThreadItem coverage at the pinned Codex version', () => {
  it.each(threadItems.variants)('classifies %s rather than leaving it a synthetic card', (type) => {
    expect(syntheticNames('item/started', type)).toEqual([]);
    expect(syntheticNames('item/completed', type)).toEqual([]);
  });

  it('still falls back visibly for a variant the pin does not know about', () => {
    expect(threadItems.variants).not.toContain('unclassifiedFuture');
    expect(syntheticNames('item/started', 'unclassifiedFuture')).toEqual([
      'codex_unclassifiedFuture',
      'codex_unclassifiedFuture',
    ]);
  });
});
