/**
 * Producer-declared run identity for a streamed assistant message.
 *
 * The AI SDK mints its OWN assistant message id unless the opening `start` chunk carries one, so
 * without this the rendered message and the row we persist under have different ids: reload the
 * chat and it comes back under ours, watch it live and it is the SDK's. Anything that later has to
 * reach an in-flight message by its durable id — a wake burst appending to the turn that armed it —
 * misses, and paints a second copy of that turn instead of extending it.
 *
 * Declaring it is the same move the chat transport already makes for user messages. Recorded as an
 * invariant in the `live-run-observer-lane` decision: rendered id == persisted row id.
 */

/** The slice of a stream-chunk payload this needs; kept structural so it works on either side of
 * the IPC boundary, where the payload type is declared twice. */
type IdentifiablePayload = { chunk: unknown; assistantMessageId: string };

/**
 * Stamp the persisted message id onto an opening chunk; every other chunk passes through untouched.
 *
 * Returns a COPY rather than mutating: the executor pushes the very same chunk object into the
 * turn's collected history, which is re-walked later to rebuild parts — an in-place write would
 * leak this field backwards into that history.
 */
export function withDeclaredRunIdentity<T extends IdentifiablePayload>(payload: T): T {
  const chunk = payload.chunk as { type?: string };
  if (chunk.type !== 'start') return payload;
  return { ...payload, chunk: { ...chunk, messageId: payload.assistantMessageId } };
}
