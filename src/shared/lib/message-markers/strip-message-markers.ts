/**
 * One stripper for the in-text display markers a user message can still carry (trigger bubble, task
 * bubble). These exist for the RENDERER — anything else that reads message text (the model prompt,
 * replayed conversation history, the search index, the rollback composer, clipboard, chat/project
 * naming) must see the body only, and several of those sites historically forgot to strip.
 *
 * TRANSITIONAL. In-text markers are the wrong mechanism: correctness depends on every present and
 * future consumer remembering to call this. Display provenance belongs in `message.metadata`, which
 * the AI SDK excludes from the model by construction (`convertToModelMessages` reads only `parts`) —
 * the shape `answered-questions` and rollback targeting already use. Migrating TRIGGER_BUBBLE/TASK_BUBBLE the same way deletes this module.
 *
 * `hidden-wake-marker` keeps its own helper: a wake message is hidden wholesale rather than rendered
 * as a card, so its marker is a lifecycle sentinel, not display metadata.
 *
 */

const MESSAGE_METADATA_COMMENT_REGEX = /<!--(?:TASK_BUBBLE|TRIGGER_BUBBLE):[\s\S]*?-->/g;

/** Remove every display marker, leaving the message body. */
export function stripMessageMarkers(text: string): string {
  return text.replace(MESSAGE_METADATA_COMMENT_REGEX, '').trim();
}

/** Same, but collapsed to a single line — for naming prompts, where layout is noise. */
export function stripMessageMarkersToOneLine(text: string): string {
  return text.replace(MESSAGE_METADATA_COMMENT_REGEX, ' ').replace(/\s+/g, ' ').trim();
}
