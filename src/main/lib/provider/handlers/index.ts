/** Per-category handler registry. Hooks and instructions have none: each launch hands those to
 * its provider itself (hooks through `hooksForLaunch`). */

import type { CapabilityCategory } from '../../../../shared/lib/ai-providers/capabilities';
import { deliverAgentBrain } from './agent-brain';
import { enforceAllowlist } from './allowlist';
import { deliverCommands } from './commands';
import { deliverMcp } from './mcp';
import { deliverPlugins } from './plugins';
import { deliverSkills } from './skills';
import type { CategoryHandlers } from './types';

const REGISTRY = {
  mcp: { deliver: deliverMcp }, // PCH-3
  skills: { deliver: deliverSkills }, // PCH-2
  commands: { deliver: deliverCommands }, // PCH-2b
  agentBrain: { deliver: deliverAgentBrain }, // PCH-4
  allowlist: { enforce: enforceAllowlist }, // PCH-5
  // Report-only: real delivery is per-session staging (session-config-dir.ts);
  // this makes its outcome probeable instead of silently dark (sc-1831).
  plugins: { deliver: deliverPlugins },
} satisfies Partial<Record<CapabilityCategory, CategoryHandlers>>;

/** Registered handlers for a category — undefined for handler-less rows. */
export function categoryHandlers(category: CapabilityCategory): CategoryHandlers | undefined {
  // SAFETY: the `in` guard proves category is a key of the literal REGISTRY.
  return category in REGISTRY ? REGISTRY[category as keyof typeof REGISTRY] : undefined;
}

export type { CategoryHandlers } from './types';
