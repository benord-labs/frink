import { useAtom } from 'jotai';
import { Zap, Brain, Rocket } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import {
  CODEX_FAST_SPEED_MULTIPLIER,
  CODEX_ULTRAFAST_SPEED_MULTIPLIER,
} from '../../../../../../shared/lib/codex-cli-models';
import type { CodexSpeed } from '../../../../../../shared/types/execution';
import { extendedThinkingEnabledAtom } from '../../../../../lib/atoms';
import { codexSpeedAtomFamily } from '../../../../../lib/atoms/codex-speed';
import { cn } from '../../../../../lib/utils';

type PaidSpeed = Exclude<CodexSpeed, 'standard'>;

/** Where Codex speed lives: an existing chat's setting, or the ref a New Chat form stages it in.
 *  `credits` holds each paid speed's multiplier for the model; `null` hides that speed. */
export type SpeedScope = {
  chatId?: string;
  newChatSpeedRef?: { current: CodexSpeed };
  credits: Record<PaidSpeed, number | null>;
};

export const ICON_BUTTON_CLASS =
  'flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring/70';

/** Top-left control: Thinking for Claude, the paid speeds a Codex model offers. */
export function ProviderToggle({
  variant,
  speed,
}: {
  variant: 'claude' | 'codex';
  speed: SpeedScope | undefined;
}): ReactElement | null {
  if (variant === 'claude') return <ThinkingToggle />;
  if (!speed) return null;
  if (speed.chatId) return <ChatSpeedToggles chatId={speed.chatId} credits={speed.credits} />;
  return speed.newChatSpeedRef ? (
    <NewChatSpeedToggles speedRef={speed.newChatSpeedRef} credits={speed.credits} />
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

function ChatSpeedToggles({
  chatId,
  credits,
}: {
  chatId: string;
  credits: SpeedScope['credits'];
}): ReactElement {
  const [speed, setSpeed] = useAtom(codexSpeedAtomFamily(chatId));
  return <SpeedToggles speed={speed} onChange={setSpeed} credits={credits} />;
}

/** Stages speed on the New Chat form's ref; the popover remounts per open, so it re-reads the ref. */
function NewChatSpeedToggles({
  speedRef,
  credits,
}: {
  speedRef: { current: CodexSpeed };
  credits: SpeedScope['credits'];
}): ReactElement {
  const [speed, setSpeed] = useState(speedRef.current);
  return (
    <SpeedToggles
      speed={speed}
      onChange={(next) => {
        speedRef.current = next;
        setSpeed(next);
      }}
      credits={credits}
    />
  );
}

const SPEED_BUTTONS = [
  { speed: 'fast', name: 'Fast mode', Icon: Zap, pace: `${CODEX_FAST_SPEED_MULTIPLIER}× speed` },
  {
    speed: 'ultrafast',
    name: 'Ultrafast mode',
    Icon: Rocket,
    pace: `up to ${CODEX_ULTRAFAST_SPEED_MULTIPLIER}× speed`,
  },
] as const;

/** One switch per paid speed the model offers; turning one on replaces the other. The credit
 *  multiplier stays visible on or off: it is the cost the user commits to. */
function SpeedToggles({
  speed,
  onChange,
  credits,
}: {
  speed: CodexSpeed;
  onChange: (speed: CodexSpeed) => void;
  credits: SpeedScope['credits'];
}): ReactElement {
  return (
    <>
      {SPEED_BUTTONS.map(({ speed: option, name, Icon, pace }) => {
        const multiplier = credits[option];
        if (multiplier === null) return null;
        const enabled = speed === option;
        const disclosure = `${name} — ${pace} · ${multiplier}× ChatGPT credits`;
        return (
          <button
            key={option}
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={disclosure}
            title={disclosure}
            className={cn(ICON_BUTTON_CLASS, enabled && 'text-primary hover:text-primary')}
            onClick={() => onChange(enabled ? 'standard' : option)}
          >
            <Icon className="h-4 w-4" />
            <span className="text-xs tabular-nums">{multiplier}×</span>
          </button>
        );
      })}
    </>
  );
}
