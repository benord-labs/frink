import { Button } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import { ListFilter } from 'lucide-react';
import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { hideFlowChatsAtom } from '@/lib/atoms';
import { cn } from '@/lib/utils';
import { STRINGS } from '../../../constants';

/** Toggles the saved Flow-chat filter; the icon stays tinted while Flow chats are hidden. */
export function FlowChatsFilterButton(): ReactElement {
  const [hideFlowChats, setHideFlowChats] = useAtom(hideFlowChatsAtom);
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={STRINGS.HIDE_FLOW_CHATS}
          aria-pressed={hideFlowChats}
          onClick={() => setHideFlowChats(!hideFlowChats)}
          className={cn(
            'size-8 shrink-0 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            hideFlowChats && 'text-primary hover:text-primary',
          )}
        >
          <ListFilter className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {hideFlowChats ? STRINGS.SHOW_FLOW_CHATS : STRINGS.HIDE_FLOW_CHATS}
      </TooltipContent>
    </Tooltip>
  );
}
