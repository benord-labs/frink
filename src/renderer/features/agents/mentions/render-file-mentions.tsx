import mcpLogo from '@iconify-icons/simple-icons/modelcontextprotocol';
import { iconifyComponent } from '@/lib/utils/iconify-component';
import React, { useMemo } from 'react';
import {
  findMentionTokens,
  MENTION_PREFIXES,
} from '../../../../shared/lib/mentions/mention-grammar';
import { type ParsedMention, parseMention } from '../../../../shared/lib/mentions/parse-mention';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../components/ui/hover-card';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { mentionChipClass } from '../../../lib/mentions/mention-chip-class';
import {
  FileText,
  Bot,
  Files,
  ToolCase,
  SquareDashedText,
  SquareDashedBottomCode,
  FolderOpen,
} from 'lucide-react';
import { AgentFileItem } from '../ui/agent-file-item';
import { getFileIconByExtension } from './agents-file-mention';

const OriginalMCPIcon = iconifyComponent(mcpLogo);

// Regex patterns - hoisted to module level for performance
const ULTRATHINK_SPLIT_REGEX = /(ultrathink)/gi;
const MULTIPLE_NEWLINES_REGEX = /\n{3,}/g;

const MENTION_CHIP_CLASS = mentionChipClass({ className: 'select-none' });

/** Quote, diff, code and pasted mentions carry text that the chip previews on hover. */
function isTextMention(mention: ParsedMention): boolean {
  return (
    mention.type === 'quote' ||
    mention.type === 'diff' ||
    mention.type === 'code' ||
    mention.type === 'pasted'
  );
}

/** One mention as a badge; turn `focusable` off inside a control that takes focus itself. */
export function MentionChip({
  mention,
  focusable = true,
}: {
  mention: ParsedMention;
  focusable?: boolean;
}) {
  if (isTextMention(mention)) return <TextMentionChip mention={mention} />;

  if (mention.type === 'briefing') {
    const preview = mention.fullText?.slice(0, 100);
    const chip = (
      <span className={MENTION_CHIP_CLASS}>
        <FileText />
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

  const isPath = mention.type === 'file' || mention.type === 'folder';
  const tooltip = isPath
    ? mention.path
    : mention.type === 'skill'
      ? `Skill: ${mention.label}`
      : mention.type === 'agent'
        ? `Agent: ${mention.label}`
        : `MCP Tool: ${mention.path}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={MENTION_CHIP_CLASS} tabIndex={focusable ? 0 : undefined}>
          <Icon />
          <span>{mention.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className={isPath ? 'font-mono wrap-anywhere' : undefined}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
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
function useRenderFileMentions(text: string, focusable: boolean): React.ReactNode[] {
  return useMemo(() => {
    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    let key = 0;

    for (const token of findMentionTokens(text)) {
      // Add text before mention (with ultrathink highlighting)
      if (token.start > lastIndex) {
        nodes.push(
          <span key={`text-${key++}`}>
            {renderTextWithUltrathink(text.slice(lastIndex, token.start))}
          </span>,
        );
      }

      const mention = parseMention(token.id);

      if (mention) {
        nodes.push(
          <MentionChip key={`mention-${key++}`} mention={mention} focusable={focusable} />,
        );
      } else {
        // Fallback: show as plain text if not a valid mention
        nodes.push(<span key={`unknown-${key++}`}>{text.slice(token.start, token.end)}</span>);
      }

      lastIndex = token.end;
    }

    // Add remaining text (with ultrathink highlighting)
    if (lastIndex < text.length) {
      nodes.push(
        <span key={`text-end-${key}`}>{renderTextWithUltrathink(text.slice(lastIndex))}</span>,
      );
    }

    return nodes;
  }, [text, focusable]);
}

/**
 * Component to render text with file mentions
 */
export function RenderFileMentions({
  text,
  className,
  focusable = true,
}: {
  text: string;
  className?: string;
  focusable?: boolean;
}) {
  const nodes = useRenderFileMentions(text, focusable);
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

  for (const { id, start, end } of findMentionTokens(text)) {
    const isQuoteOrDiffOrCodeOrPasted =
      id.startsWith(MENTION_PREFIXES.QUOTE) ||
      id.startsWith(MENTION_PREFIXES.DIFF) ||
      id.startsWith(MENTION_PREFIXES.CODE) ||
      id.startsWith(MENTION_PREFIXES.PASTED);
    if (isQuoteOrDiffOrCodeOrPasted) {
      const parsed = parseMention(id);
      if (parsed) {
        textMentions.push(parsed);
        mentionsToRemove.push(text.slice(start, end));
      }
    }
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

/** A quote, diff, code or pasted mention as the badge the composer strip shows, with a preview. */
function TextMentionChip({ mention }: { mention: ParsedMention }) {
  const isProse = mention.type === 'quote' || mention.type === 'pasted';
  const lines = mention.lineRange ?? mention.lineNumber;

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <AgentFileItem
          filename={
            isProse
              ? mention.label.trim().split('\n')[0]
              : mention.path.split('/').pop() || mention.path
          }
          icon={isProse ? SquareDashedText : undefined}
          detail={lines ? `L${lines}` : undefined}
          size={mention.type === 'pasted' ? mention.size : undefined}
          className="max-w-48"
        />
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-80 max-h-48 overflow-y-auto">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {isProse ? (
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
  const textMentions = mentions.filter(isTextMention);
  if (textMentions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {textMentions.map((mention) => (
        <TextMentionChip
          key={`${mention.type}-${mention.id}-${mention.label.slice(0, 20)}`}
          mention={mention}
        />
      ))}
    </div>
  );
}
