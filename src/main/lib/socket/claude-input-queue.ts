import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Base64ImageSource, ContentBlockParam } from '@anthropic-ai/sdk/resources';

type ImagePart = { mediaType: string; base64Data: string };

/**
 * Build a turn's initial SDK user message for the persistent-session input queue
 * (`runTurn` pushes it, whether the turn is fresh or adopts a wake arming; the queue itself
 * lives on the session and stays open past the turn so harness wakes can re-invoke the model).
 *
 * Content mirrors the pre-streaming contract: a bare string for a normal turn (byte-parity with
 * the old string prompt), an image+text block array for images / plan mode (Query.interrupt()
 * needs streaming input).
 */
export function buildClaudeUserMessage(
  fullPrompt: string,
  imageParts: ImagePart[],
  mode: string,
  /**
   * Steer only. `priority: 'next'` tells the CLI to splice this message into the ALREADY-RUNNING
   * turn at its next model invocation instead of starting a turn of its own — the in-flight tool
   * call still runs to completion. `uuid` is the handle `cancel_async_message` needs to withdraw
   * the message while it is still sitting in the CLI's command queue.
   *
   * Omitted for a normal turn, whose payload must stay byte-identical to the pre-steer contract.
   */
  steer?: { uuid: SDKUserMessage['uuid']; priority: 'next' },
): SDKUserMessage {
  const content: string | ContentBlockParam[] =
    imageParts.length === 0 && mode !== 'plan'
      ? fullPrompt
      : [
          ...imageParts.map((img): ContentBlockParam => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType as Base64ImageSource['media_type'],
              data: img.base64Data,
            },
          })),
          ...(fullPrompt.trim() ? [{ type: 'text' as const, text: fullPrompt }] : []),
        ];
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content },
    parent_tool_use_id: null,
    session_id: '', // SDK requires this; initial prompt has no session yet
    ...(steer ? { uuid: steer.uuid, priority: steer.priority } : {}),
  } satisfies SDKUserMessage;
}
