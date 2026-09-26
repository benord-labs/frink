/**
 * The one card that renders "these questions were answered, and here is what was picked" — shared by
 * both surfaces that can show it: the resolved AskUserQuestion tool result (inline in the assistant
 * message) and the user message a parked/expired answer produces. Keeping it in one place is what
 * makes an answer look the same wherever it lands in the transcript.
 *
 * The answer carries the emphasis, not the question: by the time this renders the question is
 * context and the pick is the news.
 */
import { memo } from 'react';
import type { AnsweredQuestion } from '../../../../../shared/lib/agent-questions/answered-questions';
import { ChatMarkdownRenderer } from '../../../../components/chat-markdown-renderer';
import { CircleQuestionMark } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import { agentsChatBubbleSurfaceClass } from '../../main/chat-composer-shell-classes';

type AnsweredQuestionsCardProps = {
  entries: ReadonlyArray<AnsweredQuestion>;
  className?: string;
};

export const AnsweredQuestionsCard = memo(function AnsweredQuestionsCard({
  entries,
  className,
}: AnsweredQuestionsCardProps) {
  // A question set that resolved without any answer text still deserves a trace in the transcript,
  // but an empty bordered box would read as a rendering bug.
  if (entries.length === 0) {
    return (
      <div
        className={cn('flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground', className)}
      >
        <span>Question answered</span>
      </div>
    );
  }

  return (
    // Blurred glass, not a translucent tint: in the user-message position this card is STICKY and
    // scrolling assistant text would otherwise read straight through it.
    <div className={cn(agentsChatBubbleSurfaceClass(), 'overflow-hidden', className)}>
      <div className="flex items-center gap-1.5 pl-2.5 pr-2 h-7 border-b border-border">
        <CircleQuestionMark className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {entries.length === 1 ? 'Answered' : `Answered · ${entries.length} questions`}
        </span>
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        {entries.map((entry, index) => (
          // Position disambiguates: a label is the full question text on the fallback path, and
          // questions in one ask routinely share far more than a 30-character opening clause.
          <div
            key={`qa-${index}-${entry.label.slice(0, 30)}-${entry.answer.slice(0, 20)}`}
            className="flex flex-col gap-0.5 min-w-0"
          >
            {/* Clamped because the fallback path labels a row with the FULL question text, which
                runs to thousands of characters — unclamped it buries the answer it introduces. */}
            <span className="text-[11px] text-muted-foreground wrap-break-word line-clamp-3">
              {entry.label}
            </span>
            {/* Answers are joined option labels — the same agent-authored markdown the popup
                renders. Keep in sync with AgentUserQuestion's option-label className. */}
            <ChatMarkdownRenderer
              content={entry.answer}
              size="sm"
              className="text-sm [&_p]:text-sm [&_p]:text-foreground [&_p]:py-0"
            />
          </div>
        ))}
      </div>
    </div>
  );
});
