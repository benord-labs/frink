/**
 * Permissions overhaul v2 — pure types.
 *
 * No imports from electron, sqlite, tRPC, or any storage. Ticket 02 of the
 * permissions overhaul (`docs/frink/todos/permissions-overhaul/02-rule-grammar-matcher.md`).
 *
 * Naming note: `PermissionTier`, not the spec's `PermissionScope` — "tier" is the
 * dispatcher's vocabulary, and v1 `PermissionScope` is a different, renderer-only type.
 */

// `RuleType`, `PermissionTier`, `PromptData`, `PermissionsDoc` live in
// `src/shared/types/permissions.ts` so the preload bundle and renderer can
// consume them without pulling main-process runtime modules (this file imports
// `CommandSignature` from `command-parser`, which transitively imports
// `shell-quote`). Import for local use + re-export for main-side consumers.
import type {
  PermissionsDoc,
  PermissionTier,
  PromptData,
  RuleType,
} from '../../../../shared/types/permissions';
import type { CommandSignature } from '../command-parser';

export type { PermissionsDoc, PermissionTier, PromptData, RuleType };

/** Rule string in claude-code grammar: `Bash(git push:*)`, `Edit(src/**)`, `mcp__shortcut__*`. */
export type PermissionRule = string;

export type DenyReason =
  | {
      kind: 'rule:deny';
      rule: string;
      tier: PermissionTier;
      /** Set when the rule is saved on a project linked to the chat, not the chat's own. */
      projectId?: string;
    }
  | { kind: 'safety:path'; path: string }
  | { kind: 'db:unavailable' };

/** A project linked to the chat: its registered folder and its own project rules. */
export type LinkedRoot = { projectId: string; path: string; doc: PermissionsDoc | null };

export type PermissionRequest = {
  tool: string;
  input: unknown;
  projectId: string;
  projectPath: string;
  mode?: PermissionsDoc['defaultMode'];
  signal?: AbortSignal;
  /**
   * Absolute path to the active chat's Claude session directory
   * (`{userData}/claude-sessions/{subChatId}` — the CLI's `CLAUDE_CONFIG_DIR`).
   * When set, Read tool invocations auto-allow WITHOUT prompting for exactly two
   * session-owned subtrees: `pasted/**` (paste blobs the user approved by
   * pasting) and `projects/**\/tool-results/**` (large MCP results the CLI
   * spills to disk and the agent must read back). Deliberately NOT the whole
   * dir — transcripts (`projects/<slug>/<uuid>.jsonl`), `shell-snapshots/`
   * (captured shell env), and `.claude.json` (account metadata) keep prompting.
   * Runs AFTER tier-1c system-denied. Caller is responsible for chat-isolation
   * (each chat passes only its own session dir). Optional — when absent, no
   * auto-allow runs.
   */
  sessionDirRoot?: string;
  /**
   * Absolute path to the active chat's session plans directory
   * (`{userData}/claude-sessions/{subChatId}/plans`). When set,
   * Read/Write/Edit/MultiEdit against files inside it auto-allow without
   * prompting — app-owned, per-chat plan-mode scratch the agent must author.
   * Runs AFTER tier-1c system-denied (secrets still win). Caller is responsible
   * for chat-isolation. Optional — when absent, no plan auto-allow runs.
   */
  planDirRoot?: string;
  /**
   * Folders of the projects linked to the active chat, each with that project's own
   * rules (`doc` is null when they could not be loaded, and then nothing is granted).
   * Read, Glob and Grep inside one run without asking (`linked-read`). Runs AFTER
   * tier-1c system-denied and every policy, project and user rule. It grants only when the
   * checker would ask with no rule to name (no rule matched, or the project's tool-wide
   * grant was set aside outside the project). The chat's own rules are matched again at
   * the path's real spelling, and the linked project's own deny and ask rules still
   * apply. Those checks also run on a read the chat's own rules allow inside a linked
   * folder, and the linked rules on a search of a folder that holds one. Env
   * files, and search filters that can reach one, still ask. Edits, commands
   * and every other tool are unchanged. Caller is responsible for chat-isolation (each
   * chat passes only its own links). Optional — when absent, no linked read runs.
   */
  linkedRoots?: LinkedRoot[];
  /**
   * Provider-authenticated ownership for an MCP server whose name is otherwise
   * shared across provider config formats. Omit to retain the legacy name-based
   * trust decision; false forces the normal MCP rule path.
   */
  trustedFrinkOwnedMcp?: boolean;
  /** Exact provider-supplied MCP identity. Avoids ambiguous `__` delimiters in flattened names. */
  mcpIdentity?: { server: string; tool: string };
};

/**
 * Pre-computed bash signature passed to `matchesRule` via context.
 * Re-exported from `../command-parser` (single source of truth) under a more
 * descriptive name. Ticket 03 owns extraction.
 */
export type BashCommandSignature = CommandSignature;

export type MatchContext = {
  bashCommandSignature?: BashCommandSignature;
  resolvedPath?: string;
  mcpIdentity?: { server: string; tool: string };
};

/** Dispatcher / checker return type. */
export type PermissionResult =
  | { decision: 'allow' }
  | { decision: 'ask'; prompt: PromptData }
  | { decision: 'deny'; reason: DenyReason };
