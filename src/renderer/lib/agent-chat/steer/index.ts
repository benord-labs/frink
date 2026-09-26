import { useCallback } from 'react';
import { toast } from 'sonner';
import { trpcClient } from '../../trpc';
import { isRunSettling } from './run-busy';

/**
 * Whether a steer reached the running agent.
 *
 * `queued` covers every non-delivery — an idle agent, a turn blocked on a permission prompt, a
 * provider with no steer channel, a thrown call. The caller must fall back to the message QUEUE and
 * never to a direct send: a direct send reaches the executor's duplicate-request guard, which
 * ABORTS the running turn — the exact destruction steering exists to prevent.
 */
type SteerResult = 'delivered' | 'queued';

/** Composer/queue attachment shape, before the loading and data-less ones are dropped. */
export type SteerImage = {
  mediaType?: string;
  base64Data?: string;
  isLoading?: boolean;
};

type SteerImagePart = { mediaType: string; base64Data: string };

/**
 * The attachments as inline bytes, or `null` when ANY of them cannot ride the steer channel — one
 * still loading, or URL-backed with no bytes at all. All-or-nothing on purpose: sending the subset
 * would silently drop the rest of what the user attached.
 */
function steerImages(images: readonly SteerImage[] | undefined): SteerImagePart[] | null {
  const parts: SteerImagePart[] = [];
  for (const img of images ?? []) {
    if (img.isLoading || !img.mediaType || !img.base64Data) return null;
    parts.push({ mediaType: img.mediaType, base64Data: img.base64Data });
  }
  return parts;
}

/** tRPC input for one steer; images ride along only when there are any. */
function steerInput(subChatId: string, text: string, imageParts: SteerImagePart[]) {
  return { subChatId, text, ...(imageParts.length ? { imageParts } : {}) };
}

/** Only an explicit `delivered` counts. Every other shape — a refused steer, a failed call — means
 * the agent does not have the message, so the caller must queue it. */
function readOutcome(res: { success: boolean; outcome?: string }): SteerResult {
  return res.success && res.outcome === 'delivered' ? 'delivered' : 'queued';
}

/**
 * Send a message INTO the turn already running on this sub-chat, so the agent picks it up at its
 * next model invocation instead of losing the work it is doing.
 *
 * Deliberately does NOT go through `useChat.sendMessage`: that opens a new run through the
 * transport and tears down the live stream. A steer rides its own tRPC mutation, and the running
 * turn keeps streaming into the same assistant message throughout.
 */
function useSteer(
  subChatId: string,
): (text: string, images?: readonly SteerImage[]) => Promise<SteerResult> {
  return useCallback(
    async (text, images) => {
      // An attachment-only message has nothing to steer WITH — the providers' steer channels carry
      // text, so it belongs in the queue where it will be sent as an ordinary turn.
      if (!text.trim()) return 'queued';
      const imageParts = steerImages(images);
      // Queue the whole message rather than steer a partial one — see steerImages.
      if (imageParts === null) return 'queued';
      try {
        return readOutcome(
          await trpcClient.socket.steerMessage.mutate(steerInput(subChatId, text, imageParts)),
        );
      } catch {
        // A steer that never reached main is indistinguishable from a refusal.
        return 'queued';
      }
    },
    [subChatId],
  );
}

/**
 * Steer, and fall back to the QUEUE when the agent could not take it — the only safe fallback.
 * A direct send would reach the executor's duplicate-request guard and abort the very turn the user
 * was steering, from behind a control labelled Steer.
 *
 * `requeue` is supplied by the caller because the two composer paths hold their message in
 * different places (an existing queue item vs. fresh editor content).
 */
export function useSteerOrQueue(
  subChatId: string,
): (text: string, images: readonly SteerImage[] | undefined, requeue: () => void) => Promise<void> {
  const steer = useSteer(subChatId);
  return useCallback(
    async (text, images, requeue) => {
      // Main refuses a steer into a turn it is only finalizing; queued, it goes once that settles.
      if (isRunSettling(subChatId)) return requeue();
      if ((await steer(text, images)) === 'delivered') return;
      requeue();
      // Deliberately neutral: a non-delivery can be a parked prompt, a turn that just ended, or a
      // runtime with no steer channel at all, and main cannot always tell those apart. Blaming the
      // agent ("not accepting messages") would misreport the unsupported-runtime case.
      toast.info('Could not steer the running step — added to the queue.');
    },
    [steer, subChatId],
  );
}
