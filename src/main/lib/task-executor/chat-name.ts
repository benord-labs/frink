/** The initial chat name for a task: its description as plain text, clipped. */

const TASK_CHAT_NAME_MAX_LENGTH = 100;

export function buildInitialTaskChatName(taskDescription: string): string {
  const plainText = taskDescription
    // Strip markdown links: [label](url) -> label, allowing balanced parentheses in the url
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, '$1')
    // Strip common markdown formatting markers
    .replace(/[`*_~]/g, '')
    // Strip markdown heading/blockquote markers
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    // Strip leading markdown list bullets
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (plainText.length === 0) {
    return 'Task';
  }

  // By code point: a UTF-16 slice can split an emoji's surrogate pair.
  return Array.from(plainText).slice(0, TASK_CHAT_NAME_MAX_LENGTH).join('');
}
