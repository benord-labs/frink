/**
 * Per-chat Codex "Fast mode" (the app-server `priority` service tier).
 *
 * Lives here rather than beside the other agent atoms because feature folders are UI-only, and
 * because the transport needs the support gate without importing a feature module.
 */
import { codexFastTierCredits } from '../../../shared/lib/codex-cli-models';
import { appStore } from '../jotai-store';
// Direct module import, not the `lib/atoms` barrel: the barrel re-exports `features/agents/atoms`,
// so going through it would pull a feature into a lib module.
import { createPersistedAtomFamily } from './atom-family-factory';

/**
 * Per-chat Fast state, persisted and defaulting OFF. Off is load-bearing, not just conservative:
 * the tier bills a 2-2.5x credit multiplier, so it must never arrive on by accident. A Flow seeds
 * this on dispatch (see `use-task-ipc-handler`), so one value governs every turn in the chat.
 */
export const codexFastModeAtomFamily = createPersistedAtomFamily(
  'agents:codexFastMode:perChat',
  false,
);

/**
 * The `codexFastMode` slice of an outgoing chat request, or `{}` when Fast does not apply.
 *
 * Gated on the SELECTED model advertising the tier, so a chat left on Fast while switching to a
 * model without one (or to Claude) sends nothing rather than a flag main would have to
 * refuse. `resolveCodexCliModel` re-checks in main — this gate is for the request shape, not trust.
 */
export function codexFastModeSetting(
  chatId: string | undefined,
  modelId: string | undefined,
): { codexFastMode?: boolean } {
  if (!chatId || codexFastTierCredits(modelId) === null) return {};
  return { codexFastMode: appStore.get(codexFastModeAtomFamily(chatId)) === true };
}
