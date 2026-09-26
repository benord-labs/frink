import log from 'electron-log';
import { z } from 'zod';
import { trackPRCreated } from '../../../analytics';
import { setChatPrIfChanged } from '../../../db/repos/chat-pr';

const GITHUB_PR_URL_REGEX = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\b/g;
const TEXT_PART = z.object({ type: z.literal('text'), text: z.string() });

/** Newest GitHub PR link in a finalized turn: the last match across its persisted text parts. */
export function findLatestPrUrl(parts: unknown[]): { prUrl: string; prNumber: number } | null {
  const text = parts.map((part) => TEXT_PART.safeParse(part).data?.text ?? '').join(' ');
  const last = [...text.matchAll(GITHUB_PR_URL_REGEX)].at(-1);
  return last ? { prUrl: last[0], prNumber: Number(last[1]) } : null;
}

/**
 * Single writer of the chat's PR link (see decision multi-view-surface-strategy): newest finalized
 * turn wins, unchanged links are skipped, and failures never downgrade transcript durability.
 */
export async function recordPrUrl(
  db: Parameters<typeof setChatPrIfChanged>[0],
  chatId: string,
  parts: unknown[],
  track: typeof trackPRCreated = trackPRCreated,
): Promise<void> {
  const pr = findLatestPrUrl(parts);
  if (!pr) return;
  try {
    if (await setChatPrIfChanged(db, chatId, pr)) {
      track({ workspaceId: chatId, prNumber: pr.prNumber });
    }
  } catch (err) {
    log.error('[Socket] Recording PR URL failed:', err);
    // Sentry is best-effort here; its own capture path never throws, so only the lazy load can.
    void import('../../../sentry/init')
      .then(({ captureMainException }) => captureMainException(err, { surface: 'pr-url-record' }))
      .catch(() => undefined);
  }
}
