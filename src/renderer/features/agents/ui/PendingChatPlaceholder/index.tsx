/**
 * PendingChatPlaceholder — shown in a null split pane while a new chat API call is in flight.
 * Displays the submitted message text so the user can see their message immediately on split.
 */

import { memo } from 'react';
import { Loader2 } from 'lucide-react';
import { agentsChatUserBubbleShellClass } from '../../main/chat-composer-shell-classes';

type PendingChatPlaceholderProps = {
  text: string;
};

function PendingChatPlaceholderComponent({ text }: PendingChatPlaceholderProps) {
  return (
    <div className="flex flex-col h-full p-4 gap-3">
      <div className={agentsChatUserBubbleShellClass()}>{text}</div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground pl-1">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Creating chat…</span>
      </div>
    </div>
  );
}

export const PendingChatPlaceholder = memo(PendingChatPlaceholderComponent);
