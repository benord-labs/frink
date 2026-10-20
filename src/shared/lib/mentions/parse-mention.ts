import { MENTION_PREFIXES } from './mention-grammar';
import { decodeFromMentionToken } from './mention-token-codec';

export type ParsedMention = {
  id: string;
  label: string;
  path: string;
  repository: string;
  type: 'file' | 'folder' | 'skill' | 'agent' | 'tool' | 'quote' | 'diff' | 'code' | 'pasted';
  // Extra data for quote/diff/code/pasted mentions
  fullText?: string;
  lineNumber?: number;
  /** For code: fileName and line range (e.g. "13-26") */
  lineRange?: string;
  /** For pasted: size in bytes */
  size?: number;
};

type MentionParser = (id: string) => ParsedMention | null;

const UNDERSCORE_GLOBAL_REGEX = /_/g;
const WORD_BOUNDARY_CAPITALIZE_REGEX = /\b\w/g;
const PATH_SEPARATOR_REGEX = /[\\/]/;

/** The last segment of a `/` or `\` path, or the whole path when it ends in a separator. */
export function pathLabel(path: string): string {
  return path.split(PATH_SEPARATOR_REGEX).pop() || path;
}

/** The decoded base64 part (empty when it does not decode), or the preview when there is none. */
function decodeFullText(encodedText: string, preview: string): string {
  return encodedText ? decodeFromMentionToken(encodedText) : preview;
}

/** `file:<repository>:<path>` or `folder:<repository>:<path>`; the path may contain colons. */
function parseFileOrFolderMention(id: string, type: 'file' | 'folder'): ParsedMention | null {
  const parts = id.split(':');
  if (parts.length < 3) return null;
  const path = parts.slice(2).join(':');
  return { id, label: pathLabel(path), path, repository: parts[1], type };
}

/** `skill:<name>` */
function parseSkillMention(id: string): ParsedMention {
  const label = id.slice(MENTION_PREFIXES.SKILL.length);
  return { id, label, path: '', repository: '', type: 'skill' };
}

/** `agent:<name>` */
function parseAgentMention(id: string): ParsedMention {
  const label = id.slice(MENTION_PREFIXES.AGENT.length);
  return { id, label, path: '', repository: '', type: 'agent' };
}

/** `tool:mcp__<server>__<tool>`; the label titles the tool part (get_design -> Get Design). */
function parseToolMention(id: string): ParsedMention {
  const toolPath = id.slice(MENTION_PREFIXES.TOOL.length);
  const parts = toolPath.split('__');
  const toolName = parts.length >= 3 ? parts.slice(2).join('__') : toolPath;
  const label = toolName
    .replace(UNDERSCORE_GLOBAL_REGEX, ' ')
    .replace(WORD_BOUNDARY_CAPITALIZE_REGEX, (c) => c.toUpperCase())
    .trim();
  return { id, label, path: toolPath, repository: '', type: 'tool' };
}

/** `quote:<preview>:<base64 text>`, or `quote:<text>` when there is no base64 part. */
function parseQuoteMention(id: string): ParsedMention {
  const content = id.slice(MENTION_PREFIXES.QUOTE.length);
  const separatorIdx = content.indexOf(':');
  if (separatorIdx === -1) {
    const label = content.slice(0, 50) + (content.length > 50 ? '...' : '');
    return { id, label, path: '', repository: '', type: 'quote', fullText: content };
  }
  const fullText = decodeFromMentionToken(content.slice(separatorIdx + 1));
  const label = content.slice(0, separatorIdx);
  return { id, label, path: '', repository: '', type: 'quote', fullText };
}

/** A URI-encoded path, or the path as written when it is not valid URI encoding. */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** `diff:<URI-encoded file path>:<line, 0 for none>:<preview>:<base64 text>` — older tokens carry
 * the path raw, kept as written unless it happens to be valid URI encoding (`docs/100%25.md`
 * reads as `docs/100%.md`). */
function parseDiffMention(id: string): ParsedMention | null {
  const parts = id.slice(MENTION_PREFIXES.DIFF.length).split(':');
  if (parts.length < 3) return null;
  const path = decodePath(parts[0]);
  const lineNumber = parseInt(parts[1], 10) || undefined;
  const fileName = pathLabel(path);
  const label = lineNumber ? `${fileName}:${lineNumber}` : fileName;
  const fullText = decodeFullText(parts.slice(3).join(':'), parts[2]);
  return { id, label, path, repository: '', type: 'diff', fullText, lineNumber };
}

// `code:<URI-encoded file name>:<startLine-endLine>:<preview>:<base64 text>`
// The base64 text is the last part, so the preview may contain colons.
function parseCodeMention(id: string): ParsedMention | null {
  const parts = id.slice(MENTION_PREFIXES.CODE.length).split(':');
  if (parts.length < 4) return null;
  const path = decodePath(parts[0]);
  const lineRange = parts[1];
  const fullText = decodeFullText(parts[parts.length - 1], parts.slice(2, -1).join(':'));
  const label = `${path} L${lineRange}`;
  return { id, label, path, repository: '', type: 'code', fullText, lineRange };
}

// `pasted:<size in bytes>:<preview>|<file path>`
// The last pipe separates the path, so the path may contain colons and the preview pipes.
function parsePastedMention(id: string): ParsedMention | null {
  const content = id.slice(MENTION_PREFIXES.PASTED.length);
  const pipeIndex = content.lastIndexOf('|');
  if (pipeIndex === -1) return null;
  const beforePipe = content.slice(0, pipeIndex);
  const colonIndex = beforePipe.indexOf(':');
  if (colonIndex === -1) return null;
  const size = parseInt(beforePipe.slice(0, colonIndex) || '0', 10);
  const label = beforePipe.slice(colonIndex + 1);
  const path = content.slice(pipeIndex + 1);
  return { id, label, path, repository: '', type: 'pasted', fullText: label, size };
}

const MENTION_PARSERS: ReadonlyArray<readonly [prefix: string, parse: MentionParser]> = [
  [MENTION_PREFIXES.FILE, (id) => parseFileOrFolderMention(id, 'file')],
  [MENTION_PREFIXES.FOLDER, (id) => parseFileOrFolderMention(id, 'folder')],
  [MENTION_PREFIXES.SKILL, parseSkillMention],
  [MENTION_PREFIXES.AGENT, parseAgentMention],
  [MENTION_PREFIXES.TOOL, parseToolMention],
  [MENTION_PREFIXES.QUOTE, parseQuoteMention],
  [MENTION_PREFIXES.DIFF, parseDiffMention],
  [MENTION_PREFIXES.CODE, parseCodeMention],
  [MENTION_PREFIXES.PASTED, parsePastedMention],
];

/** Parses the id of an `@[id]` mention token; null when its kind or shape is not recognised. */
export function parseMention(id: string): ParsedMention | null {
  const parser = MENTION_PARSERS.find(([prefix]) => id.startsWith(prefix));
  return parser ? parser[1](id) : null;
}
