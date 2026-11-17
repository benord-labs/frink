import { AI_PROVIDERS } from '../../../../../shared/lib/ai-providers';
import { resolveCopilotLaunch, runCopilotAgent } from '../../../agent-runner/copilot';
import type { UIMessageChunk } from '../../../claude/types';
import { agentModeFor, agentModelFor, type startAcpTurn, withNotes } from '../acp-turn';

type CopilotTurnParams = Omit<Parameters<typeof startAcpTurn>[0], 'providerId' | 'configRoot'>;

const DEFAULT_DEPS = { resolveCopilotLaunch, runCopilotAgent };

/** Runs one chat turn on GitHub Copilot, refusing in plain words when it cannot start. */
export async function* startCopilotTurn(
  params: CopilotTurnParams,
  deps = DEFAULT_DEPS,
): AsyncGenerator<UIMessageChunk, void, undefined> {
  const row = AI_PROVIDERS.copilot;
  if (!params.projectPath) throw new Error(`${row.name} needs a folder to work in.`);
  const mode = agentModeFor(row, params.mode);
  const resolved = await deps.resolveCopilotLaunch();
  if (!resolved.ok) throw new Error(`${row.name} didn't start. ${resolved.reason}`);
  const fallback = params.freshSessionFallbackPrompt;
  yield* deps.runCopilotAgent({
    launch: resolved.launch,
    cwd: params.projectPath,
    prompt: withNotes(params.prompt, params.composerNotes),
    freshSessionFallbackPrompt: fallback && withNotes(fallback, params.composerNotes),
    resumeSessionId: params.resumeSessionId,
    model: agentModelFor(params.model),
    mode: mode === 'plan' ? mode : undefined,
    images: params.images.map(({ base64Data, mediaType }) => ({
      data: base64Data,
      mimeType: mediaType,
    })),
    abortController: params.abortController,
    checkApproval: params.checkApproval,
  });
}
