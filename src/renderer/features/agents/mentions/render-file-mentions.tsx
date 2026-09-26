import mcpLogo from '@iconify-icons/simple-icons/modelcontextprotocol';
import { iconifyComponent } from '@/lib/utils/iconify-component';
/* eslint-disable max-lines, max-lines-per-function */
import React, { useMemo } from 'react';
import { MENTION_PREFIXES } from '@/lib/mentions/agents-mentions-types';
import { decodeFromMentionToken } from '@/lib/mentions/briefing-base64';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../components/ui/hover-card';
import {
  FileText,
  Bot,
  Files,
  ToolCase,
  SquareDashedText,
  SquareDashedBottomCode,
  FolderOpen,
} from 'lucide-react';
import { getFileIconByExtension } from './agents-file-mention';

const OriginalMCPIcon = iconifyComponent(mcpLogo);

// Regex patterns for parsing mentions - hoisted to module level for performance
const FILE_MENTION_REGEX = /@\[([^\]]+)\]/g;
const UNDERSCORE_GLOBAL_REGEX = /_/g;
const WORD_BOUNDARY_CAPITALIZE_REGEX = /\b\w/g;
const ULTRATHINK_SPLIT_REGEX = /(ultrathink)/gi;
const MULTIPLE_NEWLINES_REGEX = /\n{3,}/g;

// Shared mention-chip styling (theme-adaptive subtle fill)
const MENTION_CHIP_CLASS =
  'inline-flex items-center gap-1 px-[6px] rounded-[6px] text-sm align-middle bg-black/4 dark:bg-white/8 text-foreground/80 select-none';

type ParsedMention = {
  id: string;
  label: string;
  path: string;
  repository: string;
  type:
    | 'file'
    | 'folder'
    | 'skill'
    | 'agent'
    | 'tool'
    | 'quote'
    | 'diff'
    | 'code'
    | 'pasted'
    | 'briefing';
  // Extra data for quote/diff/code/pasted/briefing mentions
  fullText?: string;
  lineNumber?: number;
  /** For code: fileName and line range (e.g. "13-26") */
  lineRange?: string;
  /** For pasted: size in bytes */
  size?: number;
};

/**
 * Parse file/folder/skill/agent/tool/quote/diff mention ID into its components
 * Format: file:owner/repo:path/to/file.tsx or folder:owner/repo:path/to/folder or skill:skill-name or agent:agent-name or tool:mcp__server__toolname
 * Quote format: quote:preview_text:full_text (base64 encoded full text)
 * Diff format: diff:filepath:lineNumber:preview_text:full_text (base64 encoded full text)
 * Code format: code:fileName:startLine-endLine:preview:base64_full_text (from code editor selection)
 */
const CODE_PREFIX = 'code:';
function parseMention(id: string): ParsedMention | null {
  const isFile = id.startsWith(MENTION_PREFIXES.FILE);
  const isFolder = id.startsWith(MENTION_PREFIXES.FOLDER);
  const isSkill = id.startsWith(MENTION_PREFIXES.SKILL);
  const isAgent = id.startsWith(MENTION_PREFIXES.AGENT);
  const isTool = id.startsWith(MENTION_PREFIXES.TOOL);
  const isQuote = id.startsWith(MENTION_PREFIXES.QUOTE);
  const isDiff = id.startsWith(MENTION_PREFIXES.DIFF);
  const isPasted = id.startsWith(MENTION_PREFIXES.PASTED);
  const isBriefing = id.startsWith(MENTION_PREFIXES.BRIEFING);
  const isCode = id.startsWith(CODE_PREFIX);

  if (
    !isFile &&
    !isFolder &&
    !isSkill &&
    !isAgent &&
    !isTool &&
    !isQuote &&
    !isDiff &&
    !isCode &&
    !isPasted &&
    !isBriefing
  )
    return null;

  // Handle code selection mentions (format: code:fileName:startLine-endLine:preview:base64_full_text)
  if (isCode) {
    const content = id.slice(CODE_PREFIX.length);
    const parts = content.split(':');
    if (parts.length < 4) return null;
    let fileName = parts[0] || '';
    try {
      fileName = decodeURIComponent(fileName);
    } catch {
      // Legacy or malformed: use raw value
    }
    const lineRange = parts[1] || ''; // e.g. "13-26"
    const preview = parts.slice(2, -1).join(':'); // may contain colons
    const encodedText = parts[parts.length - 1] || '';
    let fullText = preview;
    try {
      if (encodedText) {
        fullText = decodeFromMentionToken(encodedText);
      }
    } catch {
      fullText = preview;
    }
    return {
      id,
      label: `${fileName} L${lineRange}`,
      path: fileName,
      repository: '',
      type: 'code',
      fullText,
      lineRange,
    };
  }

  // Handle quote mentions (format: quote:preview_text:base64_full_text)
  if (isQuote) {
    const content = id.slice(MENTION_PREFIXES.QUOTE.length);
    const separatorIdx = content.indexOf(':');
    if (separatorIdx === -1) {
      // Simple format without full text
      return {
        id,
        label: content.slice(0, 50) + (content.length > 50 ? '...' : ''),
        path: '',
        repository: '',
        type: 'quote',
        fullText: content,
      };
    }
    const preview = content.slice(0, separatorIdx);
    const encodedText = content.slice(separatorIdx + 1);
    let fullText = preview;
    try {
      fullText = decodeFromMentionToken(encodedText);
    } catch {
      fullText = preview;
    }
    return {
      id,
      label: preview,
      path: '',
      repository: '',
      type: 'quote',
      fullText,
    };
  }

  // Handle diff mentions (format: diff:filepath:lineNumber:preview_text:base64_full_text)
  if (isDiff) {
    const content = id.slice(MENTION_PREFIXES.DIFF.length);
    const parts = content.split(':');
    if (parts.length < 3) return null;

    const filePath = parts[0] || '';
    const lineNumber = parseInt(parts[1] || '0', 10) || undefined;
    const preview = parts[2] || '';
    const encodedText = parts.slice(3).join(':'); // Handle colons in base64

    let fullText = preview;
    try {
      if (encodedText) {
        fullText = decodeFromMentionToken(encodedText);
      }
    } catch {
      fullText = preview;
    }

    const fileName = filePath.split('/').pop() || filePath;
    const lineInfo = lineNumber ? `:${lineNumber}` : '';

    return {
      id,
      label: `${fileName}${lineInfo}`,
      path: filePath,
      repository: '',
      type: 'diff',
      fullText,
      lineNumber,
    };
  }

  // Handle pasted mentions (format: pasted:size:preview|filepath)
  // Use "|" as separator between preview and filepath since filepath can contain colons.
  if (isPasted) {
    const content = id.slice(MENTION_PREFIXES.PASTED.length);
    const pipeIndex = content.lastIndexOf('|');
    if (pipeIndex === -1) return null;

    const beforePipe = content.slice(0, pipeIndex);
    const filePath = content.slice(pipeIndex + 1);
    const colonIndex = beforePipe.indexOf(':');
    if (colonIndex === -1) return null;

    const size = parseInt(beforePipe.slice(0, colonIndex) || '0', 10);
    const preview = beforePipe.slice(colonIndex + 1);

    return {
      id,
      label: preview,
      path: filePath,
      repository: '',
      type: 'pasted',
      fullText: preview,
      size,
    };
  }

  // Handle skill mentions (simpler format: skill:name)
  if (isSkill) {
    const skillName = id.slice(MENTION_PREFIXES.SKILL.length);
    return {
      id,
      label: skillName,
      path: '',
      repository: '',
      type: 'skill',
    };
  }

  // Handle agent mentions (simpler format: agent:name)
  if (isAgent) {
    const agentName = id.slice(MENTION_PREFIXES.AGENT.length);
    return {
      id,
      label: agentName,
      path: '',
      repository: '',
      type: 'agent',
    };
  }

  // Handle tool mentions (format: tool:mcp__servername__toolname)
  if (isTool) {
    const toolPath = id.slice(MENTION_PREFIXES.TOOL.length);
    // Extract readable name from tool path (e.g., mcp__figma__get_design -> Get design)
    const parts = toolPath.split('__');
    const toolName = parts.length >= 3 ? parts.slice(2).join('__') : toolPath;
    const displayName = toolName
      .replace(UNDERSCORE_GLOBAL_REGEX, ' ')
      .replace(WORD_BOUNDARY_CAPITALIZE_REGEX, (c) => c.toUpperCase())
      .trim();
    return {
      id,
      label: displayName,
      path: toolPath,
      repository: '',
      type: 'tool',
    };
  }

  // Handle briefing mentions (format: briefing:<flowId>:<base64Name>:<base64Text>)
  if (isBriefing) {
    const content = id.slice(MENTION_PREFIXES.BRIEFING.length);
    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) return null;
    const afterFlowId = content.slice(colonIdx + 1);
    const secondColonIdx = afterFlowId.indexOf(':');
    if (secondColonIdx === -1) return null;
    let flowName = 'Briefing';
    try {
      flowName = decodeFromMentionToken(afterFlowId.slice(0, secondColonIdx)) || 'Briefing';
    } catch {
      flowName = 'Briefing';
    }
    let fullText = '';
    try {
      fullText = decodeFromMentionToken(afterFlowId.slice(secondColonIdx + 1)) ?? '';
    } catch {
      fullText = '';
    }
    return {
      id,
      label: flowName,
      path: '',
      repository: '',
      type: 'briefing',
      fullText,
    };
  }

  const parts = id.split(':');
  if (parts.length < 3) return null;

  const type = parts[0] as 'file' | 'folder';
  const repository = parts[1];
  const path = parts.slice(2).join(':'); // Handle paths with colons
  const name = path.split('/').pop() || path;

  return {
    id,
    label: name,
    path,
    repository,
    type,
  };
}

/**
 * Component to render a single file/folder/skill/agent/tool/quote/diff mention chip (matching canvas style)
 */
function MentionChip({ mention }: { mention: ParsedMention }) {
  // Quote and diff mentions render as block cards
  if (mention.type === 'quote' || mention.type === 'pasted') {
    // Get a short title from the label
    const title = mention.label.split('\n')[0]?.slice(0, 20) || mention.label.slice(0, 20);
    const displayTitle = title.length < mention.label.length ? `${title}...` : title;

    return (
      <span className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-muted/50 cursor-default min-w-[120px] max-w-[200px] align-middle">
        {/* Icon container */}
        <span className="flex items-center justify-center size-8 rounded-md bg-muted shrink-0">
          <SquareDashedText className="size-4 text-muted-foreground" />
        </span>
        {/* Text content */}
        <span className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground truncate">{displayTitle}</span>
          <span className="text-xs text-muted-foreground">
            {mention.type === 'pasted' ? 'Pasted Text' : 'Selected Text'}
          </span>
        </span>
      </span>
    );
  }

  if (mention.type === 'diff') {
    const fileName = mention.path.split('/').pop() || mention.path;

    return (
      <span className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-muted/50 cursor-default min-w-[120px] max-w-[200px] align-middle">
        {/* Icon container */}
        <span className="flex items-center justify-center size-8 rounded-md bg-muted shrink-0">
          <SquareDashedBottomCode className="size-4 text-muted-foreground" />
        </span>
        {/* Text content */}
        <span className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground truncate">{fileName}</span>
          <span className="text-xs text-muted-foreground">
            {mention.lineNumber ? `Line ${mention.lineNumber}` : 'Code selection'}
          </span>
        </span>
      </span>
    );
  }

  if (mention.type === 'code') {
    return (
      <span className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-muted/50 cursor-default min-w-[120px] max-w-[200px] align-middle">
        <span className="flex items-center justify-center size-8 rounded-md bg-muted shrink-0">
          <SquareDashedBottomCode className="size-4 text-muted-foreground" />
        </span>
        <span className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground truncate">{mention.path}</span>
          <span className="text-xs text-muted-foreground">Lines {mention.lineRange ?? '—'}</span>
        </span>
      </span>
    );
  }

  if (mention.type === 'briefing') {
    const preview = mention.fullText?.slice(0, 100);
    const chip = (
      <span className={MENTION_CHIP_CLASS}>
        <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
        <span>{mention.label}</span>
      </span>
    );

    if (!preview) return chip;

    return (
      <HoverCard openDelay={400}>
        <HoverCardTrigger asChild>{chip}</HoverCardTrigger>
        <HoverCardContent side="top" align="start" className="w-80 p-3">
          <p className="text-xs font-medium text-foreground mb-1">{mention.label}</p>
          <p className="text-xs text-muted-foreground whitespace-pre-line line-clamp-6">
            {preview}
          </p>
        </HoverCardContent>
      </HoverCard>
    );
  }

  // biome-ignore lint/style/useNamingConvention: component type variable
  const Icon =
    mention.type === 'skill'
      ? ToolCase
      : mention.type === 'agent'
        ? Bot
        : mention.type === 'tool'
          ? OriginalMCPIcon
          : mention.type === 'folder'
            ? FolderOpen
            : (getFileIconByExtension(mention.label) ?? Files);

  const title =
    mention.type === 'skill'
      ? `Skill: ${mention.label}`
      : mention.type === 'agent'
        ? `Agent: ${mention.label}`
        : mention.type === 'tool'
          ? `MCP Tool: ${mention.path}`
          : `${mention.repository}:${mention.path}`;

  return (
    <span className={MENTION_CHIP_CLASS} title={title}>
      <Icon
        className={
          mention.type === 'tool'
            ? 'h-3.5 w-3.5 text-muted-foreground shrink-0'
            : 'h-3 w-3 text-muted-foreground shrink-0'
        }
      />
      <span>{mention.label}</span>
    </span>
  );
}

/**
 * Render text with ultrathink highlighting
 */
function renderTextWithUltrathink(text: string): React.ReactNode {
  const parts = text.split(ULTRATHINK_SPLIT_REGEX);
  if (parts.length === 1) return text;

  let offset = 0;
  return parts.map((part) => {
    const partOffset = offset;
    offset += part.length;

    if (part.toLowerCase() === 'ultrathink') {
      return (
        <span
          key={`ultrathink-${partOffset}-${part.slice(0, 10)}`}
          className="chroma-text chroma-text-animate"
        >
          {part}
        </span>
      );
    }
    return <React.Fragment key={`text-${partOffset}-${part.slice(0, 10)}`}>{part}</React.Fragment>;
  });
}

/**
 * Hook to render text with file/folder mentions and ultrathink highlighting
 * Returns array of React nodes with mentions rendered as chips
 */
function useRenderFileMentions(text: string): React.ReactNode[] {
  return useMemo(() => {
    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    let key = 0;

    let match: RegExpExecArray | null = FILE_MENTION_REGEX.exec(text);
    while (match !== null) {
      // Add text before mention (with ultrathink highlighting)
      if (match.index > lastIndex) {
        nodes.push(
          <span key={`text-${key++}`}>
            {renderTextWithUltrathink(text.slice(lastIndex, match.index))}
          </span>,
        );
      }

      const id = match[1];
      const mention = parseMention(id);

      if (mention) {
        nodes.push(<MentionChip key={`mention-${key++}`} mention={mention} />);
      } else {
        // Fallback: show as plain text if not a valid mention
        nodes.push(<span key={`unknown-${key++}`}>{match[0]}</span>);
      }

      lastIndex = match.index + match[0].length;
      match = FILE_MENTION_REGEX.exec(text);
    }

    // Add remaining text (with ultrathink highlighting)
    if (lastIndex < text.length) {
      nodes.push(
        <span key={`text-end-${key}`}>{renderTextWithUltrathink(text.slice(lastIndex))}</span>,
      );
    }

    return nodes;
  }, [text]);
}

/**
 * Component to render text with file mentions
 */
export function RenderFileMentions({ text, className }: { text: string; className?: string }) {
  const nodes = useRenderFileMentions(text);
  return <span className={className}>{nodes}</span>;
}

/**
 * Extract quote/diff mentions from text and return them separately with cleaned text
 * Used for rendering these mentions as blocks above the message bubble
 */
export function extractTextMentions(text: string): {
  textMentions: ParsedMention[];
  cleanedText: string;
} {
  const textMentions: ParsedMention[] = [];
  let cleanedText = text;
  const mentionsToRemove: string[] = [];

  let match: RegExpExecArray | null = FILE_MENTION_REGEX.exec(text);
  while (match !== null) {
    const id = match[1];
    const isQuoteOrDiffOrCodeOrPasted =
      id.startsWith(MENTION_PREFIXES.QUOTE) ||
      id.startsWith(MENTION_PREFIXES.DIFF) ||
      id.startsWith('code:') ||
      id.startsWith(MENTION_PREFIXES.PASTED);
    if (isQuoteOrDiffOrCodeOrPasted) {
      const parsed = parseMention(id);
      if (parsed) {
        textMentions.push(parsed);
        mentionsToRemove.push(match[0]);
      }
    }
    match = FILE_MENTION_REGEX.exec(text);
  }

  // Remove the mentions from text
  for (const mentionStr of mentionsToRemove) {
    cleanedText = cleanedText.replace(mentionStr, '');
  }

  // Clean up extra whitespace but preserve newlines
  // Only collapse multiple spaces (not newlines) into one space
  // and trim leading/trailing whitespace from each line
  cleanedText = cleanedText
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(MULTIPLE_NEWLINES_REGEX, '\n\n') // Collapse 3+ newlines to 2
    .trim();

  return { textMentions, cleanedText };
}

/**
 * Component to render a single text mention block (quote/diff)
 * Used for displaying above message bubbles, not inline
 */
function TextMentionBlock({ mention }: { mention: ParsedMention }) {
  if (
    mention.type !== 'quote' &&
    mention.type !== 'diff' &&
    mention.type !== 'code' &&
    mention.type !== 'pasted'
  )
    return null;

  const displayTitle =
    mention.type === 'quote'
      ? mention.label.split('\n')[0]?.slice(0, 20) || mention.label.slice(0, 20)
      : mention.path?.split('/').pop() || mention.path || 'Code';

  const title = displayTitle.length < 20 ? displayTitle : `${displayTitle}...`;

  const subtitle =
    mention.type === 'quote'
      ? 'Selected Text'
      : mention.type === 'pasted'
        ? 'Pasted Text'
        : mention.type === 'code'
          ? `Lines ${mention.lineRange ?? '—'}`
          : mention.lineNumber
            ? `Line ${mention.lineNumber}`
            : 'Code selection';

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-muted/50 cursor-default min-w-[120px] max-w-[200px]">
          <div className="flex items-center justify-center size-8 rounded-md bg-muted shrink-0">
            {mention.type === 'quote' || mention.type === 'pasted' ? (
              <SquareDashedText className="size-4 text-muted-foreground" />
            ) : (
              <SquareDashedBottomCode className="size-4 text-muted-foreground" />
            )}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium text-foreground truncate">{title}</span>
            <span className="text-xs text-muted-foreground">{subtitle}</span>
          </div>
        </div>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-80 max-h-48 overflow-y-auto">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {mention.type === 'quote' || mention.type === 'pasted' ? (
              <SquareDashedText className="size-3" />
            ) : (
              <SquareDashedBottomCode className="size-3" />
            )}
            <span>
              {mention.type === 'quote'
                ? 'Selected text'
                : mention.type === 'pasted'
                  ? `Pasted text${typeof mention.size === 'number' ? ` (${mention.size} bytes)` : ''}`
                  : `${mention.path}${mention.type === 'code' && mention.lineRange ? ` L${mention.lineRange}` : mention.lineNumber ? `:${mention.lineNumber}` : ''}`}
            </span>
          </div>
          <pre className="text-sm whitespace-pre-wrap wrap-break-word font-mono">
            {mention.fullText || mention.label}
          </pre>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Component to render multiple text mention blocks
 */
export function TextMentionBlocks({ mentions }: { mentions: ParsedMention[] }) {
  const textMentions = mentions.filter(
    (m) => m.type === 'quote' || m.type === 'diff' || m.type === 'code' || m.type === 'pasted',
  );
  if (textMentions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {textMentions.map((mention) => (
        <TextMentionBlock
          key={`${mention.type}-${mention.id}-${mention.label.slice(0, 20)}`}
          mention={mention}
        />
      ))}
    </div>
  );
}
