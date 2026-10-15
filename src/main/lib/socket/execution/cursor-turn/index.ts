import { AI_PROVIDERS } from '../../../../../shared/lib/ai-providers';
import { resolveCursorLaunch, runCursorAgent } from '../../../agent-runner/cursor';
import type { UIMessageChunk } from '../../../claude/types';
import { agentModeFor, type startAcpTurn, withNotes } from '../acp-turn';

type CursorTurnParams = Omit<Parameters<typeof startAcpTurn>[0], 'providerId' | 'configRoot'> & {
  /** Names the chat's own Cursor folders, so each chat keeps its own agent. */
  chatKey: string;
};

const DEFAULT_DEPS = { resolveCursorLaunch, runCursorAgent };

/** Runs one chat turn on Cursor, on Cursor's default model, refusing in plain words when it can't. */
export async function* startCursorTurn(
  params: CursorTurnParams,
  deps = DEFAULT_DEPS,
): AsyncGenerator<UIMessageChunk, void, undefined> {
  const row = AI_PROVIDERS.cursor;
  if (!params.projectPath) throw new Error(`${row.name} needs a folder to work in.`);
  const mode = agentModeFor(row, params.mode);
  const resolved = await deps.resolveCursorLaunch({ chatKey: params.chatKey });
  if (!resolved.ok) throw new Error(`${row.name} didn't start. ${resolved.reason}`);
  const fallback = params.freshSessionFallbackPrompt;
  yield* deps.runCursorAgent({
    launch: resolved.launch,
    cwd: params.projectPath,
    prompt: withNotes(params.prompt, params.composerNotes),
    freshSessionFallbackPrompt: fallback && withNotes(fallback, params.composerNotes),
    resumeSessionId: params.resumeSessionId,
    mode: mode === 'plan' ? mode : undefined,
    images: params.images.map(({ base64Data, mediaType }) => ({
      data: base64Data,
      mimeType: mediaType,
    })),
    abortController: params.abortController,
    checkApproval: params.checkApproval,
  });
}
