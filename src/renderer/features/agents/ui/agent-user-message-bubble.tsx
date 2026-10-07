/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { formatAttachmentSummaryLabel } from '@/lib/agent-chat/format-attachment-summary';
import { extractTaskBubbleData } from '@/lib/tasks/format-task-message';
import type { AnsweredQuestion } from '../../../../shared/lib/agent-questions/answered-questions';
import { isHiddenWakeMessage } from '../../../../shared/lib/message-markers/hidden-wake-marker';
import { parseTriggerBubbleMessage } from '../../../../shared/lib/trigger-bubble-marker';
import { ChatMarkdownRenderer } from '../../../components/chat-markdown-renderer';
import { useChatMarkdownToggle } from '../../../hooks/use-chat-markdown-toggle';
import { useOverflowDetection } from '../../../hooks/use-overflow-detection';
import { cn } from '../../../lib/utils';
import { parseSlashCommandDisplayParts } from '../commands/parse-slash-command-display';
import { dataImageSrc } from '../lib/message-parts';
import { agentsChatUserBubbleShellClass } from '../main/chat-composer-shell-classes';
import { RenderFileMentions, TextMentionBlocks } from '../mentions/render-file-mentions';
import { useSearchHighlight, useSearchQuery } from '../search';
import { AnsweredQuestionsCard } from './AnsweredQuestionsCard';
import { AgentImageItem } from './agent-image-item';
import { MarkdownToggleButton } from './message-action-buttons';
import { TaskBubble } from './task-bubble';
import { TriggerBubble } from './trigger-bubble';

type AgentUserMessageBubbleProps = {
  messageId: string;
  textContent: string;
  /**
   * Display-only provenance from `message.metadata` — when present this message answered these
   * questions and renders as a card. Never part of `textContent`, so the model never sees it.
   */
  answeredQuestions?: AnsweredQuestion[];
  imageParts?: Array<{
    data?: {
      filename?: string;
      url?: string;
      base64Data?: string;
      mediaType?: string;
    };
  }>;
  /** If true, renders only images and text - no TextMentionBlocks (they're rendered by parent) */
  skipTextMentionBlocks?: boolean;
  /** Reserves the bubble's right edge for an overlaid control so text never runs under it. */
  endGutter?: boolean;
};

// Helper function to highlight text in DOM using TreeWalker
function highlightTextInDom(
  container: HTMLElement,
  searchText: string,
  currentOffset: number | null,
  currentLength: number | null,
) {
  // Remove existing highlights first
  const existingHighlights = container.querySelectorAll('.search-highlight');
  existingHighlights.forEach((el) => {
    const parent = el.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(el.textContent || ''), el);
      parent.normalize();
    }
  });

  if (!searchText) return;

  const lowerSearch = searchText.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);

  const textNodes: Text[] = [];
  let node: Text | null = walker.nextNode() as Text | null;
  while (node) {
    if (node.nodeValue?.toLowerCase().includes(lowerSearch)) {
      textNodes.push(node);
    }
    node = walker.nextNode() as Text | null;
  }

  let globalOffset: number = 0;
  for (const textNode of textNodes) {
    const text = textNode.nodeValue || '';
    const lowerText = text.toLowerCase();
    let lastIndex: number = 0;
    const fragments: (string | HTMLElement)[] = [];
    let searchIndex: number = lowerText.indexOf(lowerSearch, lastIndex);

    while (searchIndex !== -1) {
      if (searchIndex > lastIndex) {
        fragments.push(text.slice(lastIndex, searchIndex));
      }

      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = text.slice(searchIndex, searchIndex + searchText.length);

      if (currentOffset !== null && currentLength !== null) {
        const matchStart = globalOffset + searchIndex;
        if (matchStart === currentOffset) {
          mark.classList.add('search-highlight-current');
        }
      }

      fragments.push(mark);
      lastIndex = searchIndex + searchText.length;
      searchIndex = lowerText.indexOf(lowerSearch, lastIndex);
    }

    if (lastIndex < text.length) {
      fragments.push(text.slice(lastIndex));
    }

    if (fragments.length > 0) {
      const parent = textNode.parentNode;
      if (parent) {
        fragments.forEach((frag) => {
          if (typeof frag === 'string') {
            parent.insertBefore(document.createTextNode(frag), textNode);
          } else {
            parent.insertBefore(frag, textNode);
          }
        });
        parent.removeChild(textNode);
      }
    }

    globalOffset += text.length;
  }
}

export const AgentUserMessageBubble = memo(function AgentUserMessageBubble({
  messageId,
  textContent,
  answeredQuestions,
  imageParts = [],
  skipTextMentionBlocks = false,
  endGutter = false,
}: AgentUserMessageBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  // System-generated wake prompts (e.g. the Continue nudge) reach the agent but
  // never render — the user just sees the agent resume.
  const isHiddenWake = isHiddenWakeMessage(textContent);

  // Check for trigger bubble data first
  const {
    triggerData,
    triggerContext,
    fullPrompt: triggerFullPrompt,
  } = useMemo(() => parseTriggerBubbleMessage(textContent), [textContent]);

  // Check for task bubble data if no trigger data
  const { taskData, fullPrompt: taskFullPrompt } = useMemo(
    () =>
      triggerData
        ? { taskData: null, fullPrompt: triggerFullPrompt }
        : extractTaskBubbleData(textContent),
    [triggerData, triggerFullPrompt, textContent],
  );

  // Extract quote/diff mentions from the actual content (or full prompt if trigger/task)
  const contentToProcess = triggerData
    ? triggerFullPrompt
    : taskData
      ? taskFullPrompt
      : textContent;
  const { textMentions, commandName, commandText, cleanedText } = useMemo(
    () => parseSlashCommandDisplayParts(contentToProcess),
    [contentToProcess],
  );

  // Markdown render/raw toggle — only the user's prose (cleanedText) is markdown-renderable.
  const { renderMarkdown, showToggle, toggle } = useChatMarkdownToggle('user', cleanedText ?? '');

  // VS Code style overflow detection using ResizeObserver (no layout thrashing).
  // renderMarkdown is a dep: raw↔rendered changes height without changing textContent.
  const showGradient = useOverflowDetection(contentRef, [textContent, renderMarkdown]);

  // Search highlight support
  const highlights = useSearchHighlight(messageId, 0, 'text');
  const searchQuery = useSearchQuery();
  const currentHighlight = highlights.find((h) => h.isCurrent);

  // Determine if we should scroll for search (has current highlight in this message)
  const hasCurrentSearchHighlight = currentHighlight !== undefined;

  // Track previous highlight state to detect when search leaves this message
  const prevHadHighlight = useRef(false);

  // Scroll to current highlight within the user message bubble
  useEffect(() => {
    if (hasCurrentSearchHighlight && contentRef.current) {
      // Wait for DOM highlighting to be applied
      requestAnimationFrame(() => {
        const highlightEl = contentRef.current?.querySelector('.search-highlight-current');
        if (highlightEl) {
          highlightEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }

    // Reset scroll position when search leaves this message
    if (prevHadHighlight.current && !hasCurrentSearchHighlight && contentRef.current) {
      contentRef.current.scrollTop = 0;
    }

    prevHadHighlight.current = hasCurrentSearchHighlight;
  }, [hasCurrentSearchHighlight]);

  // Apply DOM-based highlighting after render
  useEffect(() => {
    if (!contentRef.current) return;

    highlightTextInDom(
      contentRef.current,
      searchQuery,
      currentHighlight?.offset ?? null,
      currentHighlight?.length ?? null,
    );

    return () => {
      if (contentRef.current) {
        const existingHighlights = contentRef.current.querySelectorAll('.search-highlight');
        existingHighlights.forEach((el) => {
          const parent = el.parentNode;
          if (parent) {
            parent.replaceChild(document.createTextNode(el.textContent || ''), el);
            parent.normalize();
          }
        });
      }
    };
  }, [searchQuery, currentHighlight?.offset, currentHighlight?.length]);

  // When expanded, we need to re-check overflow after the content changes
  const isOverflowing = showGradient && !isExpanded;

  // After all hooks: hidden wake prompts render nothing.
  if (isHiddenWake) return null;

  // Answer messages are generated and text-only — never images or mentions — so the card replaces
  // the bubble body entirely. It keeps `data-user-bubble` (MessageGroup measures it for
  // `--user-message-height`) and the data-message-id/part triple (search scroll-to-match selector).
  if (answeredQuestions?.length) {
    return (
      <div className="flex justify-start" data-user-bubble>
        <div
          className="w-full"
          data-message-id={messageId}
          data-part-index={0}
          data-part-type="text"
        >
          <AnsweredQuestionsCard entries={answeredQuestions} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start" data-user-bubble>
      <div className="space-y-2 w-full">
        {/* Show attached images from stored message */}
        {imageParts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(() => {
              const images = imageParts.map((img, idx) => ({
                id: `${messageId}-img-${idx}`,
                filename: img.data?.filename || 'image',
                url: dataImageSrc(img.data),
              }));
              // Gallery navigation only cycles through images that have a source
              const allImages = images.filter((img) => img.url);

              return images.map((img, idx) => (
                <AgentImageItem
                  key={img.id}
                  id={img.id}
                  filename={img.filename}
                  url={img.url}
                  allImages={allImages}
                  imageIndex={idx}
                />
              ));
            })()}
          </div>
        )}
        {/* Show text mentions (quote/diff) as blocks above text bubble - only if not rendered by parent */}
        {!skipTextMentionBlocks && textMentions.length > 0 && (
          <TextMentionBlocks mentions={textMentions} />
        )}
        {/* Trigger bubble - clean summary for triggered tasks */}
        {triggerData && (
          <TriggerBubble
            data={triggerData}
            triggerContext={triggerContext}
            fullPrompt={triggerFullPrompt}
          />
        )}
        {/* Task bubble - show attached task metadata */}
        {taskData && <TaskBubble data={taskData} />}
        {/* Text bubble with inline expand/collapse */}
        {!triggerData && (commandText || cleanedText) ? (
          <>
            {/* One opaque card: the clipped text, its fade and the toggle row, so a bubble stuck to
                the top of the chat never lets text scroll through beside the toggle. */}
            <div className={cn(agentsChatUserBubbleShellClass(), endGutter && 'pr-10')}>
              <div className="relative">
                <div
                  ref={contentRef}
                  className={cn(
                    !isExpanded && 'max-h-[76px] overflow-hidden',
                    hasCurrentSearchHighlight && !isExpanded && 'overflow-y-auto',
                    // A mask, not a painted fade: the card is translucent under Transparency.
                    isOverflowing &&
                      !hasCurrentSearchHighlight &&
                      'mask-b-from-[calc(100%-2.5rem)]',
                  )}
                  data-message-id={messageId}
                  data-part-index={0}
                  data-part-type="text"
                >
                  {/* Render command text inline-highlighted, then user text after */}
                  {commandName && commandText && (
                    <span className="command-input-highlight" data-command-highlight={commandName}>
                      <span className="sr-only">{`Command: ${commandName} — `}</span>
                      <RenderFileMentions text={commandText} />
                    </span>
                  )}
                  {commandText && cleanedText ? ' ' : null}
                  {cleanedText &&
                    (renderMarkdown ? (
                      // Opt-in rendered view: @[file] chips/ultrathink chroma are dropped here
                      // (quote/diff/code mentions are already extracted to TextMentionBlocks above).
                      <ChatMarkdownRenderer content={cleanedText} size="sm" />
                    ) : (
                      <RenderFileMentions text={cleanedText} />
                    ))}
                </div>
              </div>
              {/* Card footer: expand/collapse left, markdown render/raw toggle right (shown only
                  when markdown is detected). Inside the card, so a stuck bubble never bleeds. */}
              {(isOverflowing || isExpanded || showToggle) && (
                <div className="mt-1 flex items-center justify-between gap-2">
                  {isOverflowing || isExpanded ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsExpanded(!isExpanded)}
                      className="flex w-fit gap-1 text-xs h-auto px-0"
                    >
                      {isExpanded ? (
                        <>
                          <ChevronUp className="h-3 w-3" />
                          <span>Show less</span>
                        </>
                      ) : (
                        <>
                          <ChevronDown className="h-3 w-3" />
                          <span>Show more</span>
                        </>
                      )}
                    </Button>
                  ) : (
                    <span />
                  )}
                  {showToggle && (
                    <MarkdownToggleButton rendered={renderMarkdown} onToggle={toggle} />
                  )}
                </div>
              )}
            </div>
          </>
        ) : (imageParts.length > 0 || textMentions.length > 0) && !skipTextMentionBlocks ? (
          // Show "Using X" summary when no text but have attachments rendered inline
          <div
            className={cn(
              agentsChatUserBubbleShellClass(),
              'text-muted-foreground italic whitespace-normal',
              endGutter && 'pr-10',
            )}
          >
            {formatAttachmentSummaryLabel(imageParts.length, textMentions)}
          </div>
        ) : null}
      </div>
    </div>
  );
});
