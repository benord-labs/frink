/**
 * Agent execution settings and filesystem permission types shared by main, preload and renderer.
 */

// ============================================================================
// Execution Settings (shared across socket client/executor)
// ============================================================================

/**
 * Valid Claude model identifiers for the Claude Code / agent SDK path.
 * Includes short aliases (`haiku` | `sonnet` | `opus`) and version-pinned
 * Anthropic model IDs — pinning is required for Opus 4.6 / 4.7 / 4.8 / 5 / 5.5 so the SDK's
 * baked-in system prompt reflects the correct version.
 * Matches executor gating (`src/main/lib/socket/executor.ts`). UI catalog and
 * thinking variants live in `src/shared/lib/models.ts` (`CLAUDE_CODE_MODELS`).
 */
const VALID_MODELS = [
  'haiku',
  'sonnet',
  'opus',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
] as const;
type ClaudeModel = (typeof VALID_MODELS)[number];

/** Matches any Anthropic Claude model ID (e.g. claude-opus-4-8, claude-opus-4-7-20260416). */
const ANTHROPIC_MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-[0-9]+(-[0-9a-zA-Z]+)*$/;

export function parseClaudeModel(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  if (VALID_MODELS.includes(input as ClaudeModel)) return input;
  // Accept forward-compatible Anthropic model IDs (e.g. a future claude-opus-4-9).
  if (ANTHROPIC_MODEL_ID.test(input)) return input;
  return null;
}

/**
 * Claude Agent SDK `effort` — guides adaptive thinking depth (see `build-with-claude/effort`).
 * Matches the bundled Claude Code CLI `--effort` accepted set (`low|medium|high|xhigh|max`). `xhigh`
 * is only meaningful on Fable 5.1 / Fable 5 / Opus 4.8 / Opus 4.7; the SDK silently downgrades it for models
 * that don't support it, so an over-spec'd selection never errors.
 * Requires bundled CLI ≥ 2.1.173 / `@anthropic-ai/claude-agent-sdk` ≥ 0.2.141, where `xhigh` landed —
 * an older binary rejects `--effort xhigh` and crashes the executor (the reason the prior guard existed).
 */
export type ClaudeSdkEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Effort tiers the model picker offers: the SDK set plus `ultra`, which is never sent as `--effort`.
 * Ultra runs at `xhigh` and turns on the CLI's parallel-agent orchestration (`ExecutionSettings.ultra`).
 */
export type PickerEffortLevel = ClaudeSdkEffortLevel | 'ultra';

export type ExecutionSettings = {
  /** Extended thinking token budget (0-100000) */
  maxThinkingTokens?: number;
  /**
   * SDK `effort` when using adaptive thinking (especially Opus 4.7).
   * Derived from the picker model id (Low / Medium / High / Extra High).
   */
  effort?: ClaudeSdkEffortLevel;
  /** Claude model (haiku, sonnet, opus) */
  model?: ClaudeModel | string;
  /** Whether Claude task management tools (TaskCreate, TaskUpdate, etc.) are enabled */
  enableTasks?: boolean;
  /** SDK betas to enable (e.g. 1M context window) */
  betas?: string[];
  /**
   * Auto Mode (sc-639): ask the active provider's native reviewer to decide
   * eligible approval requests. The provider's sandbox and Frink hard blocks
   * remain active; unsupported providers omit this flag.
   */
  autoReviewTools?: boolean;
  /**
   * Codex "Fast mode": request the `priority` service tier. Per-chat and off by default — it bills
   * a 2-2.5x credit multiplier. A boolean rather than a tier string on purpose: main owns the model
   * catalog and is the authority on which models advertise the tier, so `resolveCodexCliModel` can
   * refuse it for a model that has none. Ignored by non-codex runtimes.
   */
  codexFastMode?: boolean;
  /**
   * Ultra effort tier: the Claude CLI's session `ultracode` setting — `xhigh` effort plus standing
   * parallel-agent workflow orchestration. Sent alongside `effort: 'xhigh'`; ignored by non-claude
   * runtimes. Why: docs/decisions/ultra-effort-tier.md
   */
  ultra?: boolean;
};

// ============================================================================
// Permissions
//
// Scope/operation vocabulary only. Permissions v2 owns the tier model and deliberately does not
// reuse these names for its own vocabulary — see src/main/lib/permissions/v2/types.ts.
// ============================================================================

/**
 * Permission scope - what top-level grouping this applies to
 *
 * Git projects: permissions shared across all clones (keyed by git_remote)
 * Custom folders: user-created folders without git (keyed by folder_id)
 */
export type PermissionScope =
  | { type: 'git_remote'; gitRemote: string } // Git projects (e.g., "github.com/user/frink")
  | { type: 'folder'; folderId: string }; // Custom folders (e.g., "Project X")

/**
 * What operations are allowed on a path
 */
export type PermissionOperation = 'read' | 'write' | 'delete';
