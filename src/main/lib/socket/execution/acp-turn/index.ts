import { type AiProviderId, aiProvider } from '../../../../../shared/lib/ai-providers';
import { isBuiltInModelId } from '../../../../../shared/lib/models';
import type { ChatMode } from '../../../../../shared/types/chat-mode';
import { resolveAcpLaunch, runAcpAgent } from '../../../agent-runner/acp';
import type { CodexApprovalCheck } from '../../../agent-runner/codex/codex-approvals';
import type { UIMessageChunk } from '../../../claude/types';
import { wrapRemindersForPrompt } from '../../operator-reminders';
import type { ExtractedImagePart } from '../../streaming/image-parts';

type AcpTurnParams = {
  providerId: AiProviderId;
  projectPath: string;
  /** The project whose instructions the agent follows, when the chat runs in its worktree. */
  configRoot?: string;
  prompt: string;
  /** Sent instead of `prompt` when the earlier session could not be continued. */
  freshSessionFallbackPrompt?: string;
  resumeSessionId?: string;
  model?: string;
  mode: ChatMode;
  images: ExtractedImagePart[];
  /** Notes on the files and text the user attached; the agent has no other channel for them. */
  composerNotes: string[];
  abortController: AbortController;
  checkApproval: CodexApprovalCheck;
};

const DEFAULT_DEPS = { resolveAcpLaunch, runAcpAgent };

/** The agent's own mode for the chat's mode, or why the agent cannot run in it. */
export function agentModeFor(
  row: { name: string; agentMode?: string; planMode?: string },
  mode: ChatMode,
): string | undefined {
  if (mode === 'debug') {
    throw new Error(`Debug mode isn't available for ${row.name} yet. Switch to Agent or Plan.`);
  }
  if (mode === 'agent') return row.agentMode;
  if (row.planMode) return row.planMode;
  throw new Error(`Plan mode isn't available for ${row.name} yet. Switch to Agent.`);
}

/** The chat's model for an agent; a Claude or OpenAI model kept from another provider is left out. */
export function agentModelFor(model: string | undefined): string | undefined {
  return model && !isBuiltInModelId(model) ? model : undefined;
}

export function withNotes(text: string, notes: string[]): string {
  return notes.length > 0 ? `${wrapRemindersForPrompt(notes)}\n\n${text}` : text;
}

/** Runs one chat turn on an ACP agent, refusing in plain words when it cannot start. */
export async function* startAcpTurn(
  params: AcpTurnParams,
  deps = DEFAULT_DEPS,
): AsyncGenerator<UIMessageChunk, void, undefined> {
  const row = aiProvider(params.providerId);
  if (row?.runtime !== 'acp') throw new Error("This AI provider can't run here.");
  if (!params.projectPath) throw new Error(`${row.name} needs a folder to work in.`);
  const mode = agentModeFor(row, params.mode);
  const resolved = await deps.resolveAcpLaunch(row.id, params.projectPath, {
    configRoot: params.configRoot,
  });
  if (!resolved.ok) throw new Error(`${row.name} didn't start. ${resolved.reason}`);
  const fallback = params.freshSessionFallbackPrompt;
  yield* deps.runAcpAgent({
    launch: resolved.launch,
    agentId: row.id,
    agentName: row.name,
    cwd: params.projectPath,
    prompt: withNotes(params.prompt, params.composerNotes),
    freshSessionFallbackPrompt: fallback && withNotes(fallback, params.composerNotes),
    resumeSessionId: params.resumeSessionId,
    model: agentModelFor(params.model),
    mode,
    images: params.images.map(({ base64Data, mediaType }) => ({
      data: base64Data,
      mimeType: mediaType,
    })),
    abortController: params.abortController,
    checkApproval: params.checkApproval,
  });
}
