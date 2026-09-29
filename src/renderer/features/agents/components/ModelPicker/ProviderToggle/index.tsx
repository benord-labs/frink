import { useAtom } from 'jotai';
import { Zap, Brain } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { CODEX_FAST_SPEED_MULTIPLIER } from '../../../../../../shared/lib/codex-cli-models';
import { extendedThinkingEnabledAtom } from '../../../../../lib/atoms';
import { codexSpeedAtomFamily } from '../../../../../lib/atoms/codex-speed';
import { cn } from '../../../../../lib/utils';

/** Where Codex Fast lives: an existing chat's setting, or the ref a New Chat form stages it in. */
export type FastScope = {
  chatId?: string;
  newChatFastRef?: { current: boolean };
  credits: number;
};

export const ICON_BUTTON_CLASS =
  'flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring/70';

/** Top-left control: Thinking for Claude, Fast for a Codex model with a priority tier. */
export function ProviderToggle({
  variant,
  fast,
}: {
  variant: 'claude' | 'codex';
  fast: FastScope | undefined;
}): ReactElement | null {
  if (variant === 'claude') return <ThinkingToggle />;
  if (!fast) return null;
  if (fast.chatId) return <ChatFastToggle chatId={fast.chatId} credits={fast.credits} />;
  return fast.newChatFastRef ? (
    <NewChatFastToggle fastRef={fast.newChatFastRef} credits={fast.credits} />
  ) : null;
}

function ThinkingToggle(): ReactElement {
  const [enabled, setEnabled] = useAtom(extendedThinkingEnabledAtom);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Thinking"
      title={enabled ? 'Thinking on' : 'Thinking off'}
      className={cn(ICON_BUTTON_CLASS, enabled && 'text-primary hover:text-primary')}
      onClick={() => setEnabled(!enabled)}
    >
      <Brain className="h-4 w-4" />
    </button>
  );
}

function ChatFastToggle({ chatId, credits }: { chatId: string; credits: number }): ReactElement {
  const [speed, setSpeed] = useAtom(codexSpeedAtomFamily(chatId));
  const enabled = speed === 'fast';
  return (
    <FastToggle
      enabled={enabled}
      onToggle={() => setSpeed(enabled ? 'standard' : 'fast')}
      credits={credits}
    />
  );
}

/** Stages Fast on the New Chat form's ref; the popover remounts per open, so it re-reads the ref. */
function NewChatFastToggle({
  fastRef,
  credits,
}: {
  fastRef: { current: boolean };
  credits: number;
}): ReactElement {
  const [enabled, setEnabled] = useState(fastRef.current);
  return (
    <FastToggle
      enabled={enabled}
      onToggle={() => {
        fastRef.current = !enabled;
        setEnabled(!enabled);
      }}
      credits={credits}
    />
  );
}

/** Codex Fast. The credit multiplier stays visible on or off: it is the cost the user commits to,
 *  and this may be the only place they see it before it applies. */
function FastToggle({
  enabled,
  onToggle,
  credits,
}: {
  enabled: boolean;
  onToggle: () => void;
  credits: number;
}): ReactElement {
  const disclosure = `${CODEX_FAST_SPEED_MULTIPLIER}× speed · ${credits}× ChatGPT credits`;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`Fast mode — ${disclosure}`}
      title={`Fast mode — ${disclosure}`}
      className={cn(ICON_BUTTON_CLASS, enabled && 'text-primary hover:text-primary')}
      onClick={onToggle}
    >
      <Zap className="h-4 w-4" />
      <span className="text-xs tabular-nums">{credits}×</span>
    </button>
  );
}
