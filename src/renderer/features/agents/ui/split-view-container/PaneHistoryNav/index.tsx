import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue, useSetAtom } from 'jotai';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type PaneNavDirection, paneHistoryAtom } from '@/lib/atoms/pane-history';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
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
    <HistoryButtons
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

function HistoryButtons({
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
      <HistoryButton direction="back" target={targets.back} paneIndex={paneIndex} />
      <HistoryButton direction="forward" target={targets.forward} paneIndex={paneIndex} />
    </>
  );
}

function HistoryButton({
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
  const label = target ? `${verb} to “${target.name || 'Untitled chat'}”` : verb;
  const button = (
    <Button
      variant="ghost"
      size="sm"
      disabled={!target}
      onClick={(e) => {
        e.stopPropagation();
        if (target) showChatInPane({ chatId: target.id, paneIndex, direction });
      }}
      className={cn(
        'text-xs p-2 rounded motion-reduce:transition-none',
        !target && 'text-muted-foreground/60 cursor-not-allowed',
      )}
      aria-label={label}
      iconOnly
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  );
  if (!target) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
