import { Button } from '@benord-labs/frink-primitives';
import { Plus } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import { HIDE_ATTACH_TIER } from '../../main/chat-composer-shell-classes';

type Props = { label: string; onClick: () => void; disabled: boolean };

/** The composer's attach control, shared by the new-chat and active-chat toolbars. */
export function ComposerAttachButton({ label, onClick, disabled }: Props) {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      className={cn(
        'h-7 w-7 shrink-0 rounded-md text-muted-foreground outline-offset-2 hover:bg-foreground/5 hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring/70',
        HIDE_ATTACH_TIER,
      )}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Plus className="h-4 w-4" />
    </Button>
  );
}
