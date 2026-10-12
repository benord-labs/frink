/** The prefix that opens the id of each kind of `@[id]` mention token. */
export const MENTION_PREFIXES = {
  FILE: 'file:',
  FOLDER: 'folder:',
  SKILL: 'skill:',
  AGENT: 'agent:',
  TOOL: 'tool:', // MCP tools
  QUOTE: 'quote:', // Selected text from assistant messages
  DIFF: 'diff:', // Selected text from diff sidebar
  CODE: 'code:', // Selected lines from the code editor
  PASTED: 'pasted:', // Large pasted text saved as files
  BRIEFING: 'briefing:', // Flow briefing (format: briefing:<flowId>:<base64Name>:<base64Text>)
} as const;

/** Strips characters that would break the `@[type:preview:payload]` mention grammar. */
export const MENTION_PREVIEW_SANITIZE_REGEX = /[:[\]]/g;

/** Source of the `@[id]` token pattern (group 1 is the id), for building a RegExp per scan. */
export const MENTION_TOKEN_PATTERN_SRC = '@\\[([^\\]]+)\\]';

export type MentionToken = {
  id: string;
  /** Offset of the opening `@`. */
  start: number;
  /** Offset just past the closing `]`. */
  end: number;
};

/** Every `@[id]` token in `text`, in order. Each call scans with its own RegExp. */
export function findMentionTokens(text: string): MentionToken[] {
  return Array.from(text.matchAll(new RegExp(MENTION_TOKEN_PATTERN_SRC, 'g')), (match) => ({
    id: match[1],
    start: match.index,
    end: match.index + match[0].length,
  }));
}
