import { Button } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import { MessageSquarePlus } from 'lucide-react';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { pendingTerminalOutputAtomFamily } from '@/lib/terminal/pending-output';
import { readRecentOutput } from '@/lib/terminal/recent-output';
import { getTerminalInstance } from '@/lib/terminal/terminal-instances';
import type { TerminalInstance } from '../types';

const LABEL = 'Send selection or recent output to chat';

type Props = {
  chatId: string;
  /** The pane the button reads: the one that has keyboard focus. */
  terminal: TerminalInstance | null;
  tooltipSide?: 'top' | 'bottom';
  /** Called once the text is on its way, e.g. to leave a fullscreen terminal for the chat. */
  onSent?: () => void;
};

/** Puts the pane's selection, or its newest output, in this chat's composer as an attachment. */
export function SendToChatButton({ chatId, terminal, tooltipSide = 'bottom', onSent }: Props) {
  const setPending = useSetAtom(pendingTerminalOutputAtomFamily(chatId));

  const send = useCallback(() => {
    const xterm = terminal && getTerminalInstance(terminal.paneId);
    if (!terminal || !xterm) return;
    const selection = xterm.getSelection().trimEnd();
    const text = selection || readRecentOutput(xterm.buffer.active);
    if (!text) {
      toast('This terminal has no output yet');
      return;
    }
    setPending({ text, label: `${terminal.name} ${selection ? 'selection' : 'output'}` });
    onSent?.();
  }, [terminal, setPending, onSent]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={send}
          disabled={!terminal}
          className="h-7 w-7 p-0 touch-target-h7 text-muted-foreground transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] hover:text-foreground shrink-0 rounded-md"
          aria-label={LABEL}
          iconOnly
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{LABEL}</TooltipContent>
    </Tooltip>
  );
}
