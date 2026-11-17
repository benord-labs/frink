import { Badge } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import { type AiProviderId, aiProvider } from '../../../shared/lib/ai-providers';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

/** A quiet "Preview" tag beside the name of a provider that lacks some of Frink's features. */
export function ProviderPreviewTag({ provider }: { provider: AiProviderId }): ReactElement | null {
  if (!aiProvider(provider)?.preview) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge noDot className="shrink-0 px-1.5 py-0 font-normal text-muted-fg">
          Preview
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        In preview: chats work, but Flows, building a Flow from a chat, your MCP servers and your
        hooks don't work with it yet.
      </TooltipContent>
    </Tooltip>
  );
}
