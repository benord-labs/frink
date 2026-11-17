import type { ReactElement } from 'react';
import { aiProviderMark } from '@/components/AiProviderMark';
import { cn } from '@/lib/utils';
import type { AccountType } from '../auth-flow-utils';

const NEUTRAL_TILE = 'bg-muted text-foreground shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]';

const TILE_CLASS = {
  'claude-code': 'bg-[#D97757] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]',
  // The white Codex tile needs a dark rim to keep its edge on light cards.
  codex: 'bg-white text-black shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)]',
  opencode: NEUTRAL_TILE,
  copilot: NEUTRAL_TILE,
  cursor: NEUTRAL_TILE,
  grok: NEUTRAL_TILE,
} satisfies Record<AccountType, string>;

/** The provider's mark on its own brand colour, matching the connect pages' tiles. */
export function ProviderTile({
  type,
  size = 'md',
}: {
  type: AccountType;
  size?: 'sm' | 'md';
}): ReactElement {
  const Mark = aiProviderMark(type);
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center',
        TILE_CLASS[type],
        size === 'md' ? 'size-9 rounded-[10px]' : 'size-5 rounded-[5px]',
      )}
    >
      <Mark className={size === 'md' ? 'size-5' : 'size-3'} />
    </span>
  );
}

/** The provider's bare mark, for inline use in a button: Claude in its brand colour, others in ink. */
export function ProviderMark({ type }: { type: AccountType }): ReactElement {
  const Mark = aiProviderMark(type);
  return <Mark className={cn('size-3.5 shrink-0', type === 'claude-code' && 'text-[#D97757]')} />;
}
