import { MessageCircle } from 'lucide-react';
import { memo } from 'react';
import type { AssistantMessageMetadata } from '../../../../shared/types/assistant-message';

/** Bounds the DOM against a message near the CLI's size cap; any real hand-over is far shorter. */
const MAX_BODY_CHARS = 2000;

type PeerMessage = NonNullable<AssistantMessageMetadata['peerMessage']>;

/** What another session sent, shown above the reply it started. Plain text on purpose: the body is
 * another agent's words, so it never goes through the markdown renderer. */
export const PeerMessageQuote = memo(function PeerMessageQuote({
  message,
}: {
  message: PeerMessage;
}) {
  const body = message.body?.slice(0, MAX_BODY_CHARS);
  return (
    <div className="mb-2 border-l-2 border-border pl-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageCircle className="size-3.5" aria-hidden />
        <span>Message from {message.name ? `@${message.name}` : 'another session'}</span>
      </div>
      {body && (
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {body}
        </p>
      )}
    </div>
  );
});
