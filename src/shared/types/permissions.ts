/**
 * Permission-related types shared between main and preload.
 *
 * These types are pure (no runtime imports) so the preload bundle can import
 * them without pulling main-process runtime modules (e.g. `shell-quote`,
 * which is transitively imported by `permissions/v2/types.ts` via
 * `command-parser`). The canonical source-of-truth re-exports from this
 * file at `src/main/lib/permissions/v2/types.ts`.
 *
 * Ticket 11 step 2 of the permissions overhaul.
 */

import type { FlowConsentPromptData } from './flows/flow-consent';

/** Stored rule classification — also the dispatcher's decision result. */
export type RuleType = 'allow' | 'deny' | 'ask';

/** Storage tier for a `PermissionsDoc`. */
export type PermissionTier = 'project' | 'user' | 'policy';

/**
 * Per-scope rule bundle. Strings use the v2 grammar (`Bash(npm:*)`,
 * `Edit(src/**)`, `mcp__*`). Matches the shape returned by the
 * `listProjectRules` / `listUserRules` / `getPolicyDoc` tRPC procedures.
 */
export type PermissionsDoc = {
  allow: string[];
  deny: string[];
  ask: string[];
  defaultMode?: 'default' | 'plan';
};

/**
 * Tool names that participate in the file-op flow (Read / Edit / Write / Delete /
 * MultiEdit / NotebookEdit). Single source of truth: the dispatcher imports from
 * here, and the renderer imports from here to drive the file-op branch in
 * `FourButtonView`. Pure data — safe across the main/renderer boundary.
 */
export const PATH_TOOLS: ReadonlySet<string> = new Set<string>([
  'Edit',
  'Read',
  'Write',
  'Delete',
  'MultiEdit',
  'NotebookEdit',
]);

/** Search tools gated on the folder they read (`permissions/v2/search`). */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set<string>(['Glob', 'Grep']);

/**
 * Classification of the path involved in a file-op permission request, relative
 * to the chat's current project. Drives the prompt UI: in-project paths can be
 * granted tool-wide at project scope; outside paths only get Deny / Allow once.
 */
export type PathLocation = 'in-current-project' | 'outside';

export type CustomNodeResourceChange = 'added' | 'changed' | 'removed' | 'unchanged';

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Host-produced registration details for the canonical Frink custom-node tool. */
export type CustomNodeRegistrationPresentation = {
  type: 'custom-node-registration';
  /** User-supplied source folder; absent when the node was registered inline. */
  packagePath?: string;
  action: 'create' | 'replace';
  /** True when an inline registration replaces a folder-installed node, deleting its modules and data files. */
  replacesPackage?: boolean;
  node: {
    name: string;
    displayName?: string;
    description?: string;
    version?: string;
    entrypoint: string;
  };
  source: {
    current: string;
    previous?: string;
  };
  modules: Array<{
    path: string;
    current: string;
    previous?: string;
    change: CustomNodeResourceChange;
  }>;
  resources: Array<{
    path: string;
    bytes: number;
    change: CustomNodeResourceChange;
  }>;
  credentialNames: string[];
  test?: {
    config: Record<string, JsonValue>;
    timeoutMs: number;
  };
  packageDigest: string;
  packageBytes: number;
  warning: string;
};

export type PermissionPresentation = CustomNodeRegistrationPresentation;

/**
 * Reason payload for an `ask` decision. Surfaced to the renderer prompt.
 * `tool` + `input` are always present; `matchedRule` / `matchedTier` only when
 * `reason === 'rule:ask'`. `suggestedRules` is the dispatcher's candidate
 * rule-string list for the renderer's dropdown. `pathLocation` is populated by
 * file-op checkers (Read/Edit/Write/Delete/MultiEdit/NotebookEdit) so the
 * renderer can drive the 3-button file-op flow. `presentation` is reserved for
 * trusted, host-produced previews and never comes from tool arguments.
 */
export type PromptData = {
  tool: string;
  input: unknown;
  /** `untraced`: Frink could not prove no rule covers the command (a label only). */
  reason: 'no-matching-rule' | 'over-50-subcommands' | 'rule:ask' | 'untraced';
  matchedRule?: string;
  matchedTier?: PermissionTier;
  suggestedRules?: string[];
  pathLocation?: PathLocation;
  /** Trusted presentation built by Frink after validating the requested operation. */
  presentation?: PermissionPresentation;
};

/** Renderer-safe wire projection of a main-owned socket permission wait. */
export type SocketPermissionProjection = {
  chatId: string;
  subChatId: string;
  requestId: string;
  type: 'file' | 'bash' | 'mcp_tool' | 'flow_consent';
  path: string;
  operation: 'read' | 'write' | 'delete' | 'bash' | 'mcp_tool' | 'flow_consent';
  reason?: string;
  toolName?: string;
  projectName?: string;
  projectPath?: string;
  prompt?: PromptData;
  /** Set for type 'flow_consent' — the per-flow agent-run card. */
  flowConsent?: FlowConsentPromptData;
};

export type PendingMoveChatProjection = {
  requestId: string;
  chatId: string;
  subChatId: string;
  operation: 'move_chat';
  projectId: string;
  projectName: string;
  targetChatId: string;
  targetSubChatId: string;
  projectPath: string;
  requestedWorktreePath: string | null;
  targetBranch: string | null;
};

export type PendingPermissionProjection = SocketPermissionProjection | PendingMoveChatProjection;

/** Result of `parseRule`. Discriminated by presence of `error`. */
export type ParsedRule = { tool: string; content?: string } | { error: string };

/**
 * Operation kind for a tool — drives the permission UI taxonomy and dispatcher
 * fast-paths (see `tool-validation.ts:getOperationFromToolName`).
 */
export type ToolOperation = 'read' | 'write' | 'delete';

/**
 * Canonical tool → operation map. Single source of truth for which tools the
 * permission system recognises. The validator (`validate-rule.ts`) uses this
 * set to reject typos and unknown tool names from `AddRuleInput`; the
 * dispatcher uses the operation for its file-op fast-paths.
 *
 * Add a new tool here in one place and the validator, the operation lookup,
 * and any future consumer pick it up.
 *
 * MCP tools (`mcp__*`) are NOT enumerated here — the MCP server universe is
 * open and the parser's `mcp__` regex already enforces shape.
 */
export const TOOL_OPERATIONS: Readonly<Record<string, ToolOperation>> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  WebFetch: 'read',
  WebSearch: 'read',
  Edit: 'write',
  Write: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Bash: 'write',
  Task: 'write',
  Agent: 'write', // Claude Code's current subagent-dispatch tool (Task is its older name)
  TodoWrite: 'write',
  ExitPlanMode: 'write',
  Delete: 'delete',
};

/** Set form of `TOOL_OPERATIONS` keys. Used for membership checks. */
export const KNOWN_TOOLS: ReadonlySet<string> = new Set(Object.keys(TOOL_OPERATIONS));

/**
 * Tools the agent needs to function. Denying these via a rule produces a
 * broken-agent state with no clear feedback (planner stuck in plan mode,
 * todo tracking silently dropped, subagent dispatch unavailable). The
 * validator rejects `deny` rules targeting any of these — users can still
 * `allow` or `ask`, just not `deny`.
 *
 * NOT a security boundary — `isSystemDeniedPath` and the file-op tier-1c
 * checks remain the canonical kill-switches. This list is UX scaffolding:
 * stop users from accidentally bricking their own agent.
 */
export const REQUIRED_TOOLS: ReadonlySet<string> = new Set<string>([
  'ExitPlanMode', // planner exit transition
  'TodoWrite', // agent task tracking
  'Task', // subagent dispatch (older tool name)
  'Agent', // subagent dispatch (Claude Code's current tool name)
  // Sub-agent report delivery to the parent (CLI-granted). Deliberately absent from
  // TOOL_OPERATIONS/KNOWN_TOOLS: it is never a user-rule target.
  'SubagentHandback',
]);

// ---------------------------------------------------------------------------
// Socket permission transport
// ---------------------------------------------------------------------------

export type SocketPermissionResponsePayload = {
  chatId: string;
  subChatId: string;
  requestId: string;
  approved: boolean;
  /**
   * Set by system-driven paths: the executor's prompt timeout, the socket
   * disconnect drain, or the renderer's pane-close auto-cancellation. Never set
   * by an explicit user click. Persistence paths must NOT treat this as a real
   * Deny — that creates phantom permanent blocks when the prompt never reached
   * the user.
   */
  timedOut?: boolean;
  /**
   * v2 response fields emitted by the four-button UI:
   *   `scope` undefined  → "Allow once" or "Deny" (no rule persisted).
   *   `scope` 'project'  → "Allow for project" — persisted at project tier.
   *   `scope` 'user'     → "Allow on machine" — persisted at user tier.
   * `ruleString` + `ruleType` carry the rule to persist at `scope`.
   */
  scope?: 'project' | 'user';
  ruleString?: string;
  ruleType?: RuleType;
  /**
   * Set by the flow-consent card's "Always allow this Flow" button. Distinct
   * from `scope` because a flow grant writes `flows.agent_invocable`, not a
   * permission rule — sharing a field would make them indistinguishable.
   */
  flowGrant?: boolean;
};
