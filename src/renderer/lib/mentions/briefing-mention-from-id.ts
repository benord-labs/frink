/**
 * Parse display label from a serialized briefing mention id (`briefing:<flowId>:…`).
 * Shared by buildMentionsInto and resolveMention so serialized hydration matches live resolution.
 */

import { decodeFromMentionToken } from '@/lib/mentions/briefing-base64';

const BRIEFING_PREFIX = 'briefing:' as const;

/**
 * Returns the chip label for a briefing mention id, or `null` if `id` is not a briefing mention.
 */
export function parseBriefingMentionLabel(id: string): string | null {
  if (!id.startsWith(BRIEFING_PREFIX)) return null;
  const content = id.slice(BRIEFING_PREFIX.length);
  const parts = content.split(':');
  try {
    const flowName = parts.length >= 2 ? decodeFromMentionToken(parts[1] ?? '') : 'Briefing';
    return flowName || 'Briefing';
  } catch {
    return 'Briefing';
  }
}
