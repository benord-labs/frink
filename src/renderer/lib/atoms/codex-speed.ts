/** Per-chat Codex speed (`fast` = the app-server `priority` tier). In lib/, not the agents
 *  feature: feature folders are UI-only and the transport must not import a feature module. */
import type { CodexSpeed } from '../../../shared/types/execution';
// Direct module import, not the `lib/atoms` barrel: the barrel re-exports `features/agents/atoms`,
// so going through it would pull a feature into a lib module.
import { createMainBackedAtomFamily } from './atom-family-factory';

/** Owned by main (shared with the phone); defaults to `standard` because `fast` bills a credit
 *  multiplier. A Flow seeds it on dispatch (`use-task-ipc-handler`). */
export const codexSpeedAtomFamily = createMainBackedAtomFamily<CodexSpeed>(
  'agents:codexSpeed:perChat',
  'standard',
  'codexSpeed',
);
