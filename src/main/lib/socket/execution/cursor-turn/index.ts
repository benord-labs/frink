import { AI_PROVIDERS } from '../../../../../shared/lib/ai-providers';
import { rememberedAgentModels } from '../../../agent-runner/agent-models';
import { cursorModelFor, resolveCursorLaunch, runCursorAgent } from '../../../agent-runner/cursor';
import type { UIMessageChunk } from '../../../claude/types';
import { agentModeFor, agentModelFor, type startAcpTurn, sharedTurnInputs } from '../acp-turn';

type CursorTurnParams = Omit<Parameters<typeof startAcpTurn>[0], 'providerId' | 'configRoot'> & {
  /** Names the chat's own Cursor folders, so each chat keeps its own agent. */
  chatKey: string;
};

const DEFAULT_DEPS = { resolveCursorLaunch, runCursorAgent };

/** Runs one chat turn on Cursor, refusing in plain words when it can't. */
export async function* startCursorTurn(
  params: CursorTurnParams,
  deps = DEFAULT_DEPS,
): AsyncGenerator<UIMessageChunk, void, undefined> {
  const row = AI_PROVIDERS.cursor;
  if (!params.projectPath) throw new Error(`${row.name} needs a folder to work in.`);
  const mode = agentModeFor(row, params.mode);
  const chosen = cursorModelFor(rememberedAgentModels('cursor'), agentModelFor(params.model));
  if (chosen.refusal) throw new Error(chosen.refusal);
  const resolved = await deps.resolveCursorLaunch({ chatKey: params.chatKey });
  if (!resolved.ok) throw new Error(`${row.name} didn't start. ${resolved.reason}`);
  yield* deps.runCursorAgent({
    ...sharedTurnInputs(params),
    launch: resolved.launch,
    model: chosen.model,
    mode: mode === 'plan' ? mode : undefined,
  });
}
