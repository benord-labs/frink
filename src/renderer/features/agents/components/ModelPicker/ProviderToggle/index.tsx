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
 *  `credits` holds each paid speed's multiplier for the model (`null`: none); `offered` is whether
 *  the account can use it. A speed already on stays shown, so it can always be turned off. */
export type SpeedScope = {
  chatId?: string;
  newChatSpeedRef?: { current: CodexSpeed };
  credits: Record<PaidSpeed, number | null>;
  offered: Record<PaidSpeed, boolean>;
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
  if (speed.chatId) return <ChatSpeedToggles chatId={speed.chatId} scope={speed} />;
  return speed.newChatSpeedRef ? (
    <NewChatSpeedToggles speedRef={speed.newChatSpeedRef} scope={speed} />
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

function ChatSpeedToggles({ chatId, scope }: { chatId: string; scope: SpeedScope }): ReactElement {
  const [speed, setSpeed] = useAtom(codexSpeedAtomFamily(chatId));
  return <SpeedToggles speed={speed} onChange={setSpeed} scope={scope} />;
}

/** Stages speed on the New Chat form's ref; the popover remounts per open, so it re-reads the ref. */
function NewChatSpeedToggles({
  speedRef,
  scope,
}: {
  speedRef: { current: CodexSpeed };
  scope: SpeedScope;
}): ReactElement {
  const [speed, setSpeed] = useState(speedRef.current);
  return (
    <SpeedToggles
      speed={speed}
      onChange={(next) => {
        speedRef.current = next;
        setSpeed(next);
      }}
      scope={scope}
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
  scope,
}: {
  speed: CodexSpeed;
  onChange: (speed: CodexSpeed) => void;
  scope: SpeedScope;
}): ReactElement {
  return (
    <>
      {SPEED_BUTTONS.map(({ speed: option, name, Icon, pace }) => {
        const multiplier = scope.credits[option];
        const enabled = speed === option;
        if (multiplier === null || (!scope.offered[option] && !enabled)) return null;
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
