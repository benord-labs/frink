import claudeLogo from '@iconify-icons/simple-icons/claude';
import openaiLogo from '@iconify-icons/ri/openai-fill';
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';
import { iconifyComponent } from '@/lib/utils/iconify-component';
import type { AccountType } from '../auth-flow-utils';

const ClaudeMark = iconifyComponent(claudeLogo);
const OpenAiMark = iconifyComponent(openaiLogo);

export const PROVIDER_NAME = {
  'claude-code': 'Claude',
  codex: 'OpenAI',
} satisfies Record<AccountType, string>;

/** The provider's mark on its own brand colour, matching the connect pages' tiles. */
export function ProviderTile({
  type,
  size = 'md',
}: {
  type: AccountType;
  size?: 'sm' | 'md';
}): ReactElement {
  const Mark = type === 'codex' ? OpenAiMark : ClaudeMark;
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center',
        // The white Codex tile needs a dark rim to keep its edge on light cards.
        type === 'codex'
          ? 'bg-white text-black shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)]'
          : 'bg-[#D97757] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]',
        size === 'md' ? 'size-9 rounded-[10px]' : 'size-5 rounded-[5px]',
      )}
    >
      <Mark className={size === 'md' ? 'size-5' : 'size-3'} />
    </span>
  );
}
