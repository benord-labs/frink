import type { IconProps } from '@iconify/react/offline';
import openaiLogo from '@iconify-icons/ri/openai-fill';
import claudeLogo from '@iconify-icons/simple-icons/claude';
import opencodeLogo from '@iconify-icons/simple-icons/opencode';
import { Bot } from 'lucide-react';
import type { ReactElement } from 'react';
import { iconifyComponent } from '@/lib/utils/iconify-component';
import { type AiProviderId, aiProvider } from '../../../shared/lib/ai-providers';

type MarkProps = Omit<IconProps, 'icon'>;
type Mark = (props: MarkProps) => ReactElement;

/** A neutral glyph for a provider with no mark of its own, so it never borrows another's. */
function FallbackMark({ className }: MarkProps): ReactElement {
  return <Bot className={className} aria-hidden />;
}

const MARKS = {
  'claude-code': iconifyComponent(claudeLogo),
  codex: iconifyComponent(openaiLogo),
  opencode: iconifyComponent(opencodeLogo),
  copilot: FallbackMark,
  grok: FallbackMark,
} satisfies Record<AiProviderId, Mark>;

/** The provider's mark as a stable component; a missing type is a legacy Claude account. */
export function aiProviderMark(provider: string | null | undefined): Mark {
  const id = aiProvider(provider)?.id;
  return id ? MARKS[id] : FallbackMark;
}
