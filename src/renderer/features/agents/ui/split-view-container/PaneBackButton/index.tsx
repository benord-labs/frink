import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue, useSetAtom } from 'jotai';
import { ArrowLeft } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { paneHistoryAtom } from '@/lib/atoms/pane-history';
import { trpc } from '@/lib/trpc';
import { splitViewChatIdsAtom } from '../../../atoms';
import { showChatInPaneAtom } from '../../../hooks/use-split-view-actions';

type PaneBackButtonProps = { chatId: string; paneIndex: number };

/** Returns a pane to the newest chat it showed before that is not open in another pane and is
 *  still in the chat list (not archived or deleted). Renders nothing when there is none. */
export function PaneBackButton({ chatId, paneIndex }: PaneBackButtonProps) {
  const history = useAtomValue(paneHistoryAtom)[chatId];
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  const candidates = history?.filter((id) => !chatIds.includes(id)) ?? [];
  if (candidates.length === 0) return null;
  return <BackToChatButton candidates={candidates} paneIndex={paneIndex} />;
}

function BackToChatButton({ candidates, paneIndex }: { candidates: string[]; paneIndex: number }) {
  const showChatInPane = useSetAtom(showChatInPaneAtom);
  const { data: backChat } = trpc.chats.list.useQuery(
    {},
    {
      select: (chats) =>
        candidates.flatMap((id) => chats.find((chat) => chat.id === id) ?? []).at(-1) ?? null,
    },
  );
  if (!backChat) return null;

  const label = `Back to “${backChat.name || 'Untitled chat'}”`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            showChatInPane({ chatId: backChat.id, paneIndex, goingBack: true });
          }}
          className="text-xs p-2 rounded motion-reduce:transition-none"
          aria-label={label}
          iconOnly
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
