import { KeyRound } from 'lucide-react';
import { TERMINAL_TOOL_PART_STATES } from '../../../../../shared/types/assistant-message';
import { getStringValue, type ToolMeta } from '../tool-registry-shared';

/** The chat row for `frink_request_secret`: which secret the agent asked for, and its file. Spread
 * into agent-tool-registry.tsx, which has no line headroom left. */
export const SECRET_REQUEST_TOOL_ENTRY = {
  'tool-frink_request_secret': {
    icon: KeyRound,
    title: (part) => {
      const verb = TERMINAL_TOOL_PART_STATES.has(part.state ?? '') ? 'Asked' : 'Asking';
      return `${verb} for ${getStringValue(part.input, 'name')}`;
    },
    subtitle: (part) => getStringValue(part.input, 'file') || '.env',
    variant: 'simple',
  },
} satisfies Record<string, ToolMeta>;
