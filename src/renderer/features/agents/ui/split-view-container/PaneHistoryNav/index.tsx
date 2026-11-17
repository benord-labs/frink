import { useAtomValue, useSetAtom } from 'jotai';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { type PaneNavDirection, paneHistoryAtom } from '@/lib/atoms/pane-history';
import { trpc } from '@/lib/trpc';
import { splitViewChatIdsAtom } from '../../../atoms';
import { showChatInPaneAtom } from '../../../hooks/use-split-view-actions';

type PaneHistoryNavProps = { chatId: string; paneIndex: number };
type NavChat = { id: string; name: string | null };

const NAV = {
  back: { icon: ArrowLeft, verb: 'Back' },
  forward: { icon: ArrowRight, verb: 'Forward' },
} as const;

/** Back/Forward through the chats this pane has shown, skipping any open in another pane or no
 *  longer in the chat list (archived or deleted). Renders nothing until there is somewhere to go. */
export function PaneHistoryNav({ chatId, paneIndex }: PaneHistoryNavProps) {
  const entry = useAtomValue(paneHistoryAtom)[chatId];
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  if (!entry) return null;
  return (
    <HistoryItems
      back={notShownIn(entry.back, chatIds)}
      forward={notShownIn(entry.forward, chatIds)}
      paneIndex={paneIndex}
    />
  );
}

function notShownIn(ids: readonly string[], shownChatIds: readonly (string | null)[]): string[] {
  return ids.filter((id) => !shownChatIds.includes(id));
}

function nearestLiveChat(chats: readonly NavChat[], ids: readonly string[]): NavChat | null {
  return ids.flatMap((id) => chats.find((chat) => chat.id === id) ?? []).at(-1) ?? null;
}

function HistoryItems({
  back,
  forward,
  paneIndex,
}: {
  back: string[];
  forward: string[];
  paneIndex: number;
}) {
  const { data: targets } = trpc.chats.list.useQuery(
    {},
    {
      select: (chats) => ({
        back: nearestLiveChat(chats, back),
        forward: nearestLiveChat(chats, forward),
      }),
    },
  );
  if (!targets?.back && !targets?.forward) return null;
  return (
    <>
      <HistoryItem direction="back" target={targets.back} paneIndex={paneIndex} />
      <HistoryItem direction="forward" target={targets.forward} paneIndex={paneIndex} />
      <DropdownMenuSeparator />
    </>
  );
}

function HistoryItem({
  direction,
  target,
  paneIndex,
}: {
  direction: PaneNavDirection;
  target: NavChat | null;
  paneIndex: number;
}) {
  const showChatInPane = useSetAtom(showChatInPaneAtom);
  const { icon: Icon, verb } = NAV[direction];
  return (
    <DropdownMenuItem
      disabled={!target}
      onClick={(e) => e.stopPropagation()}
      onSelect={() => {
        if (target) showChatInPane({ chatId: target.id, paneIndex, direction });
      }}
    >
      <Icon className="h-4 w-4 mr-2" aria-hidden="true" />
      <span className="truncate">
        {target ? `${verb} to “${target.name || 'Untitled chat'}”` : verb}
      </span>
    </DropdownMenuItem>
  );
}
