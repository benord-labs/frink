import type { HookEvent, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

type Specific = NonNullable<SyncHookJSONOutput['hookSpecificOutput']>;
type SpecificEvent = Specific['hookEventName'];
type SpecificOf<E> = Extract<Specific, { hookEventName: E }>;
/** One schema per field of the SDK's output for `E`: a field missing or extra fails typecheck. */
type FieldsOf<E extends SpecificEvent> = {
  [K in Exclude<keyof SpecificOf<E>, 'hookEventName'>]-?: z.ZodType<SpecificOf<E>[K]>;
};

/** What Claude's hook reference defines for one event. */
export type HookEventRule = {
  /** The input field a matcher is tested against; absent where a matcher is ignored. */
  matcher?: string;
  /** An exact matcher here is letters, digits, `_` and `|` only; anything else is a regex. */
  narrowMatcher?: true;
  /**
   * Exit code 2: `blocks` the action; `tells-claude` or `tells-user` the stderr text without
   * blocking; `unhonoured` ignores that one code; `ignored` ignores every exit code and failure.
   */
  exit2: 'blocks' | 'tells-claude' | 'tells-user' | 'unhonoured' | 'ignored';
  /** On exit 2 the hook's `hookSpecificOutput` is not read, even where exit codes are ignored. */
  exit2DropsSpecific?: true;
  /** What else blocks the action: a timeout, or any failure including a timeout. */
  alsoBlocksOn?: 'timeout' | 'failure';
  /** Stdout that is not JSON: added to Claude's context on exit 0, or holds the worktree path. */
  stdout?: 'context' | 'path';
  /** A top-level `decision: "block"` blocks, with `reason`. */
  decision?: true;
  /** Dropped unread: `continue` and `stopReason`; those and `systemMessage`; or all output. */
  discards?: 'continue' | 'common' | 'output';
};

const text = z.string().optional();
const flag = z.boolean().optional();
const record = z.record(z.string(), z.unknown()).optional();

/** More entries than any hook needs; checking each item of a longer list costs seconds. */
const MAX_LIST_ITEMS = 10_000;

/** A list whose oversize case fails in one step rather than once per item. */
function list<T extends z.ZodType>(item: T) {
  return z.preprocess((value, ctx) => {
    if (!Array.isArray(value) || value.length <= MAX_LIST_ITEMS) return value;
    ctx.addIssue({ code: 'custom', message: `has more than ${MAX_LIST_ITEMS} entries` });
    return z.NEVER;
  }, z.array(item));
}

/** `F` rejects a field the SDK lacks even when it comes from a shared constant or a spread. */
function specific<E extends SpecificEvent, F extends FieldsOf<E>>(
  hookEventName: E,
  fields: F & Record<Exclude<keyof F, keyof FieldsOf<E>>, never>,
) {
  return z.object({ hookEventName: z.literal(hookEventName), ...fields });
}

const CONTEXT = { additionalContext: text };
const WATCH = { watchPaths: list(z.string()).optional() };
const ELICITATION = { action: z.enum(['accept', 'decline', 'cancel']).optional(), content: record };

const destination = z.enum([
  'userSettings',
  'projectSettings',
  'localSettings',
  'session',
  'cliArg',
]);
const PERMISSION_UPDATE = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['addRules', 'replaceRules', 'removeRules']),
    rules: list(z.object({ toolName: z.string(), ruleContent: text })),
    behavior: z.enum(['allow', 'deny', 'ask']),
    destination,
  }),
  z.object({
    type: z.literal('setMode'),
    // The reference also accepts `manual`, its newer name for `default`.
    mode: z
      .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto', 'manual'])
      .transform((mode) => (mode === 'manual' ? 'default' : mode)),
    destination,
  }),
  z.object({
    type: z.enum(['addDirectories', 'removeDirectories']),
    directories: list(z.string()),
    destination,
  }),
]);
const PERMISSION_DECISION = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    updatedInput: record,
    updatedPermissions: list(PERMISSION_UPDATE).optional(),
  }),
  z.object({ behavior: z.literal('deny'), message: text, interrupt: flag }),
]);

// Keyed by the SDK's own list, so an event that gains or loses a hookSpecificOutput fails here.
const SPECIFIC_OUTPUTS = {
  PreToolUse: specific('PreToolUse', {
    permissionDecision: z.enum(['allow', 'deny', 'ask', 'defer']).optional(),
    permissionDecisionReason: text,
    updatedInput: record,
    ...CONTEXT,
  }),
  PostToolUse: specific('PostToolUse', {
    ...CONTEXT,
    classifierContext: text,
    updatedToolOutput: z.unknown().optional(),
    updatedMCPToolOutput: z.unknown().optional(),
  }),
  PostToolUseFailure: specific('PostToolUseFailure', CONTEXT),
  PostToolBatch: specific('PostToolBatch', CONTEXT),
  Notification: specific('Notification', CONTEXT),
  UserPromptSubmit: specific('UserPromptSubmit', {
    ...CONTEXT,
    sessionTitle: text,
    suppressOriginalPrompt: flag,
  }),
  UserPromptExpansion: specific('UserPromptExpansion', {
    ...CONTEXT,
    suppressOriginalPrompt: flag,
  }),
  SessionStart: specific('SessionStart', {
    ...CONTEXT,
    ...WATCH,
    initialUserMessage: text,
    sessionTitle: text,
    reloadSkills: flag,
  }),
  Setup: specific('Setup', CONTEXT),
  Stop: specific('Stop', CONTEXT),
  SubagentStart: specific('SubagentStart', CONTEXT),
  SubagentStop: specific('SubagentStop', CONTEXT),
  PreModelSwitch: specific('PreModelSwitch', {
    permissionDecision: z.enum(['allow', 'deny', 'ask']).optional(),
    permissionDecisionReason: text,
  }),
  PostModelSwitch: specific('PostModelSwitch', CONTEXT),
  PermissionRequest: specific('PermissionRequest', { decision: PERMISSION_DECISION }),
  PermissionDenied: specific('PermissionDenied', { retry: flag }),
  Elicitation: specific('Elicitation', ELICITATION),
  ElicitationResult: specific('ElicitationResult', ELICITATION),
  CwdChanged: specific('CwdChanged', WATCH),
  FileChanged: specific('FileChanged', WATCH),
  WorktreeCreate: specific('WorktreeCreate', { worktreePath: z.string() }),
  MessageDisplay: specific('MessageDisplay', { displayContent: text }),
} satisfies { [E in SpecificEvent]: z.ZodType<SpecificOf<E>> };
const [firstSpecific, ...otherSpecific] = Object.values(SPECIFIC_OUTPUTS);

// Keyed by the SDK's output type, so a field the SDK adds or removes fails typecheck here.
export const HOOK_OUTPUT_FIELDS = {
  continue: flag,
  suppressOutput: flag,
  stopReason: text,
  decision: z.enum(['approve', 'block']).optional(),
  systemMessage: text,
  terminalSequence: text,
  reason: text,
  hookSpecificOutput: z
    .discriminatedUnion('hookEventName', [firstSpecific, ...otherSpecific])
    .optional(),
} satisfies Record<keyof SyncHookJSONOutput, z.ZodType>;

/** The JSON a hook may print, on any event; unknown keys are dropped. */
export const HOOK_OUTPUT: z.ZodType<SyncHookJSONOutput> = z.object(HOOK_OUTPUT_FIELDS);

/** Keyed by the SDK's event list, so an event the SDK adds or removes fails typecheck. */
type HookEventRules = {
  [E in HookEvent]: HookEventRule & { matcher?: keyof Extract<HookInput, { hook_event_name: E }> };
};

export const HOOK_EVENT_RULES: HookEventRules = {
  PreToolUse: { matcher: 'tool_name', exit2: 'blocks', decision: true },
  PostToolUse: { matcher: 'tool_name', exit2: 'tells-claude', decision: true },
  PostToolUseFailure: { matcher: 'tool_name', exit2: 'tells-claude', decision: true },
  PostToolBatch: { exit2: 'blocks', decision: true },
  Notification: { matcher: 'notification_type', exit2: 'ignored', discards: 'common' },
  UserPromptSubmit: { exit2: 'blocks', stdout: 'context', decision: true },
  UserPromptExpansion: {
    matcher: 'command_name',
    exit2: 'blocks',
    stdout: 'context',
    decision: true,
  },
  SessionStart: { matcher: 'source', exit2: 'tells-user', stdout: 'context' },
  SessionEnd: { matcher: 'reason', exit2: 'tells-user', discards: 'output' },
  Stop: { exit2: 'blocks', decision: true },
  StopFailure: { matcher: 'error', narrowMatcher: true, exit2: 'ignored', discards: 'output' },
  SubagentStart: { matcher: 'agent_type', exit2: 'tells-user' },
  SubagentStop: { matcher: 'agent_type', exit2: 'blocks', decision: true },
  PreCompact: { matcher: 'trigger', exit2: 'blocks', decision: true, discards: 'common' },
  PostCompact: { matcher: 'trigger', exit2: 'tells-user', discards: 'common' },
  // Both model events match the canonical name of `to_model`, not the field as sent.
  PreModelSwitch: { matcher: 'to_model', exit2: 'blocks', alsoBlocksOn: 'timeout', decision: true },
  PostModelSwitch: { matcher: 'to_model', exit2: 'tells-user', stdout: 'context' },
  PermissionRequest: { matcher: 'tool_name', exit2: 'unhonoured' },
  // The reference says `retry` is the only output this event reads.
  PermissionDenied: { matcher: 'tool_name', exit2: 'ignored', discards: 'common' },
  Setup: { matcher: 'trigger', exit2: 'ignored', discards: 'output' },
  TeammateIdle: { exit2: 'blocks' },
  TaskCreated: { exit2: 'blocks', decision: true, discards: 'continue' },
  TaskCompleted: { exit2: 'blocks' },
  Elicitation: {
    matcher: 'mcp_server_name',
    exit2: 'blocks',
    exit2DropsSpecific: true,
    discards: 'common',
  },
  ElicitationResult: {
    matcher: 'mcp_server_name',
    exit2: 'blocks',
    exit2DropsSpecific: true,
    discards: 'common',
  },
  ConfigChange: { matcher: 'source', exit2: 'blocks', decision: true, discards: 'common' },
  // A command hook prints the path as plain text; the JSON form is for the other handler kinds.
  WorktreeCreate: { exit2: 'blocks', alsoBlocksOn: 'failure', stdout: 'path', discards: 'common' },
  WorktreeRemove: { exit2: 'blocks', alsoBlocksOn: 'failure', discards: 'output' },
  InstructionsLoaded: { matcher: 'load_reason', exit2: 'ignored', discards: 'output' },
  CwdChanged: { exit2: 'tells-user', discards: 'continue' },
  // Tested against the file's base name; the matcher is also the literal list of files to watch.
  FileChanged: {
    matcher: 'file_path',
    narrowMatcher: true,
    exit2: 'tells-user',
    discards: 'continue',
  },
  DirectoryAdded: { matcher: 'source', exit2: 'ignored', discards: 'continue' },
  MessageDisplay: { exit2: 'ignored', exit2DropsSpecific: true, discards: 'common' },
};
