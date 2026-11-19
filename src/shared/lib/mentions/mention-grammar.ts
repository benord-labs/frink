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
} as const;

/** A file token's second slot says where the file came from: `local` when the user picked it,
 * this one for the file open in the editor, attached without the user picking it. */
export const OPEN_EDITOR_FILE_SOURCE = 'editor';

/** The second slot of a file or folder token the user picked, from the @ menu or the file tree. */
export const PICKED_PATH_SOURCE = 'local';

/** Strips characters that would break the `@[type:preview:payload]` mention grammar. */
export const MENTION_PREVIEW_SANITIZE_REGEX = /[:[\]]/g;

/** A bracket pair without whitespace, holding at most one more pair, as in `[id]` or `[[...slug]]`. */
const BRACKET_PAIR = '\\[(?:[^\\s\\[\\]]|\\[[^\\s\\[\\]]*\\])*\\]';

/** Source of the `@[id]` token pattern (group 1 is the id), for building a RegExp per scan. An id
 * may hold bracket pairs, as in `app/[id]/page.tsx`, and whitespace anywhere but between a pair and
 * the next `/`, `\` or the id's end, so a path in a folder with spaces keeps its brackets. Any
 * other id, such as one with an unpaired bracket, ends at its first `]`, so a stray bracket later
 * in a sentence cannot pull prose into a token. */
export const MENTION_TOKEN_PATTERN_SRC = `@\\[((?:[^\\[\\]]|${BRACKET_PAIR}(?:[^\\s\\[\\]/\\\\]|${BRACKET_PAIR})*(?=[/\\\\\\]]))+|[^\\]]+)\\]`;

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

/** Whether `id` reads back as one whole `@[id]` token; some paths with brackets do not. */
export function isWholeMentionId(id: string): boolean {
  const tokens = findMentionTokens(`@[${id}]`);
  return tokens.length === 1 && tokens[0].id === id;
}
