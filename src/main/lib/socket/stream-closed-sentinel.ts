import type { UIMessageChunk } from '../claude/types';

/**
 * Regression sentinel for the "Stream closed" bug. After the streaming-input fix a permission-gated
 * tool must never see a closed CLI control channel; if one ever surfaces again as a tool-output-error,
 * report it to Sentry instead of letting the agent silently stall on a never-resolving end-of-turn
 * signal (stuck agent). Fires only on that abnormal post-fix path, so it is a quiet alarm, not noise.
 *
 * Sentry is loaded lazily (dynamic import) so this common-path helper doesn't drag sentry/init — and
 * its top-level `electron` app import — into the executor's static module graph.
 */
export function reportIfControlChannelClosed(
  chunk: UIMessageChunk,
  subChatId: string,
  /** Names the closer so the report is diagnosable without transcript archaeology — e.g. the
   * abort source that superseded the turn, or whether a wake hold owned the session. */
  context?: Record<string, string | boolean | undefined>,
): void {
  if (chunk.type === 'tool-output-error' && chunk.errorText.includes('Stream closed')) {
    void import('../sentry/init')
      .then(({ captureMainMessage }) => {
        captureMainMessage(
          'Claude control channel closed before a permission-gated tool',
          'error',
          {
            subChatId,
            ...context,
          },
        );
      })
      .catch(() => {
        // never let a reporting failure affect the turn
      });
  }
}
