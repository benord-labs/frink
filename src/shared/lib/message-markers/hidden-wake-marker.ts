/**
 * Hidden "wake" messages — system-generated prompts (e.g. the Continue nudge) that
 * must reach the agent but never render as a user bubble. The marker rides on the persisted
 * message text: the renderer hides marked messages (agent-user-message-bubble), and the executor
 * strips the marker before the text reaches the model.
 *
 */

export const HIDDEN_WAKE_MARKER = '<!--FRINK_HIDDEN_WAKE-->';

export function buildHiddenWakeMessage(text: string): string {
  return `${HIDDEN_WAKE_MARKER}${text}`;
}

export function isHiddenWakeMessage(text: string): boolean {
  return text.startsWith(HIDDEN_WAKE_MARKER);
}

export function stripHiddenWakeMarker(text: string): string {
  return isHiddenWakeMessage(text) ? text.slice(HIDDEN_WAKE_MARKER.length) : text;
}
