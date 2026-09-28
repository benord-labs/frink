/**
 * Per-chat Codex "Fast mode" (the app-server `priority` service tier).
 *
 * Lives here rather than beside the other agent atoms because feature folders are UI-only, and
 * because the transport needs the support gate without importing a feature module.
 */
// Direct module import, not the `lib/atoms` barrel: the barrel re-exports `features/agents/atoms`,
// so going through it would pull a feature into a lib module.
import { createMainBackedAtomFamily } from './atom-family-factory';

/**
 * Per-chat Fast state, owned by main (shared with the phone) and defaulting OFF. Off is load-bearing, not just conservative:
 * the tier bills a 2-2.5x credit multiplier, so it must never arrive on by accident. A Flow seeds
 * this on dispatch (see `use-task-ipc-handler`), so one value governs every turn in the chat.
 */
export const codexFastModeAtomFamily = createMainBackedAtomFamily(
  'agents:codexFastMode:perChat',
  false,
  'codexFastMode',
);
