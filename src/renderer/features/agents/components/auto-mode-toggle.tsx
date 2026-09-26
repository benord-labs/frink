import { Button } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import { useState } from 'react';
import { ToggleLeft, ToggleRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  COMPOSER_CONTROL_CLASS,
  COMPOSER_CONTROL_LABEL_CLASS,
} from '../main/chat-composer-shell-classes';
import {
  type AutoModeContext,
  useAutoModeAvailability,
} from '../../../hooks/useAutoModeAvailability';
import { autoModePerChatAtomFamily } from '../atoms';

type AutoModeToggleProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  available: boolean;
  unavailableReason: string;
};

type AutoModeTogglePresentationContext = Pick<
  AutoModeToggleProps,
  'checked' | 'available' | 'unavailableReason'
>;

function getAutoModeTogglePresentation({
  checked: on,
  available,
  unavailableReason,
}: AutoModeTogglePresentationContext) {
  if (!available) {
    return {
      on,
      disabled: true,
      label: `Auto Mode unavailable — ${unavailableReason}`,
      text: 'Auto unavailable',
      className: 'text-muted-foreground/70',
    };
  }
  return {
    on,
    disabled: false,
    label: on
      ? 'Auto Mode on — your provider reviews eligible approval requests'
      : 'Auto Mode off — eligible approval requests ask you',
    text: on ? 'Auto on' : 'Auto off',
    // The switch glyph carries the state; no filled background. Never a caution colour: Auto is
    // the safe review default, not Codex's "full access".
    className: on ? 'text-primary hover:text-primary' : 'text-muted-foreground',
  };
}

/** Auto Mode control: a switch glyph drawn on or off, labelled where the composer is wide. It stays
 *  present when unavailable so keyboard and assistive-technology users can discover why. */
export function AutoModeToggle({
  checked,
  onCheckedChange,
  unavailableReason,
  ...props
}: AutoModeToggleProps) {
  const presentation = getAutoModeTogglePresentation({ checked, unavailableReason, ...props });

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={presentation.disabled}
      onClick={() => onCheckedChange(!checked)}
      aria-pressed={presentation.on}
      aria-label={presentation.label}
      title={props.available ? presentation.label : unavailableReason}
      className={cn(
        COMPOSER_CONTROL_CLASS,
        'motion-reduce:transition-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring/70',
        presentation.className,
      )}
    >
      {presentation.on ? (
        <ToggleRight className="h-4 w-4 shrink-0" aria-hidden />
      ) : (
        <ToggleLeft className="h-4 w-4 shrink-0" aria-hidden />
      )}
      {/* "Auto on" and "Auto off" differ in width, so the label is sized by the wider of the two
          (an invisible twin in the same grid cell) and the model button never shifts on toggle. */}
      <span className={cn(COMPOSER_CONTROL_LABEL_CLASS, 'grid text-left')} aria-hidden>
        <span className="col-start-1 row-start-1">{presentation.text}</span>
        <span className="invisible col-start-1 row-start-1">Auto off</span>
      </span>
    </Button>
  );
}

/** Active chat control: per-chat state, always editable when Auto is available. A Flow seeds it. */
export function ChatAutoModeToggle({ chatId, ...context }: AutoModeContext & { chatId: string }) {
  const [checked, onCheckedChange] = useAtom(autoModePerChatAtomFamily(chatId));
  const { available, unavailableReason } = useAutoModeAvailability(context);
  return (
    <AutoModeToggle
      checked={checked}
      onCheckedChange={onCheckedChange}
      available={available}
      unavailableReason={unavailableReason}
    />
  );
}

/** New chat control: keeps a local selection and mirrors it to the creation snapshot ref. */
export function StagedAutoModeToggle({
  autoModeRef,
  ...context
}: AutoModeContext & { autoModeRef: { current: boolean } }) {
  const [checked, setChecked] = useState(autoModeRef.current);
  const { available, unavailableReason } = useAutoModeAvailability(context);
  return (
    <AutoModeToggle
      checked={checked}
      onCheckedChange={(next) => {
        autoModeRef.current = next;
        setChecked(next);
      }}
      available={available}
      unavailableReason={unavailableReason}
    />
  );
}
