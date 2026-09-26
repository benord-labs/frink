/**
 * Everything that wraps or prepends text around a turn's prompt.
 *
 * Grouped because they share one contract: a built-in slash command only dispatches at prompt
 * position 0, so each of these returns such a prompt untouched (see isCompactCommand). Guarding
 * some but not all is worse than guarding none — the composer drops the user's attached context on
 * the assumption the text is a command, so any surviving prefix loses that context AND fails to
 * dispatch.
 */
export { applyApprovedPlanContextToPrompt } from './approved-plan-prompt';
export { formatPromptWithHistory } from './prompt-history';
