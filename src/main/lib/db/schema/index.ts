/* eslint-disable max-lines, max-lines-per-function */
import { relations, sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { CODEX_SPEEDS } from '../../../../shared/types/execution';
import { createId } from '../utils';
import { defineFlowRunAdmissions } from './flow-run-admissions';
// ============ PROJECTS ============
export const projects = sqliteTable('projects', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  // Git remote info (extracted from local .git)
  gitRemoteUrl: text('git_remote_url'),
  gitProvider: text('git_provider'), // "github" | "gitlab" | "bitbucket" | null
  gitOwner: text('git_owner'),
  gitRepo: text('git_repo'),
  // AI-assisted description generated on first add; NULL until a description worker fills it.
  description: text('description'),
  // Storage tier for permission rules: false = local sqlite only, true = Neon mirror.
  isCrossMachine: integer('is_cross_machine', { mode: 'boolean' }).notNull().default(false),
});

export const projectsRelations = relations(projects, ({ many }) => ({
  chats: many(chats),
  aiAccountAssignments: many(projectAiAccounts),
  agents: many(projectAgents),
}));

// ============ PROJECT ↔ AI ACCOUNT ROUTING ============
// Per-project AI account override, keyed on the credential's primary key. `account_label`
// is NOT unique (two providers can both be labelled "Personal"), so a label-keyed override
// could not name a single row and every reader had to guess. No row for a project = use the
// workspace default; to clear an override, delete the row. The account_id cascade is how a
// deleted account's overrides are cleaned up, and a rename cannot affect an override at all.
export const projectAiAccounts = sqliteTable('project_ai_accounts', {
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  accountId: text('account_id')
    .notNull()
    .references(() => claudeCodeCredentials.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const projectAiAccountsRelations = relations(projectAiAccounts, ({ one }) => ({
  project: one(projects, {
    fields: [projectAiAccounts.projectId],
    references: [projects.id],
  }),
}));

// ============ CHATS ============
export const chats = sqliteTable(
  'chats',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text('name'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }), // Nullable for general chats
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    archivedAt: integer('archived_at', { mode: 'timestamp' }),
    // Worktree fields (for git isolation per chat)
    worktreePath: text('worktree_path'),
    branch: text('branch'),
    baseBranch: text('base_branch'),
    prUrl: text('pr_url'),
    prNumber: integer('pr_number'),
    taskId: text('task_id'), // The task driving this chat (a work queue item or Flow agent task)
    // Default sub-chat mode for new sub-chats in this chat
    mode: text('mode').default('agent'), // 'plan' | 'agent'
    // Pinned chats appear at top of sidebar (NULL = not pinned)
    pinnedAt: integer('pinned_at', { mode: 'timestamp' }),
    // Per-chat worktree history: JSON-as-text `Record<projectId, worktreePath>` (parsed by
    // helpers in repos/chats.ts — matches the subChats.messages JSON-text pattern). Used to
    // auto-restore a chat's previous worktree when it's moved back to a project it visited
    // before (the move-chat collapse would otherwise abandon the original worktree).
    // MACHINE-LOCAL: do not sync to cloud — worktree paths are filesystem-local.
    worktreeHistory: text('worktree_history'),
    // Composer settings every window and the phone share (NULL = default; see chat-composer).
    composerModelId: text('composer_model_id'),
    composerAutoMode: integer('composer_auto_mode', { mode: 'boolean' }),
    composerCodexSpeed: text('composer_codex_speed', { enum: CODEX_SPEEDS }),
    accountId: text('account_id').references(() => claudeCodeCredentials.id, {
      onDelete: 'set null', // Stamped at creation; a deleted login leaves NULL and blocks the chat.
    }),
    provider: text('provider').notNull().default('claude-code'), // Stamped at creation; never changes.
  },
  (table) => [index('chats_worktree_path_idx').on(table.worktreePath)],
);

export const chatsRelations = relations(chats, ({ one, many }) => ({
  project: one(projects, {
    fields: [chats.projectId],
    references: [projects.id],
  }),
  subChats: many(subChats),
}));

// ============ SUB-CHATS ============
export const subChats = sqliteTable('sub_chats', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name'),
  chatId: text('chat_id')
    .notNull()
    .references(() => chats.id, { onDelete: 'cascade' }),
  sessionId: text('session_id'), // Claude SDK session ID for resume
  streamId: text('stream_id'), // Track in-progress streams
  mode: text('mode').notNull().default('agent'), // "plan" | "agent"
  messages: text('messages').notNull().default('[]'), // JSON array
  // Diff stats use DEFAULT 0 without NOT NULL to match migration 0005.
  additions: integer('additions').default(0),
  deletions: integer('deletions').default(0),
  fileCount: integer('file_count').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const subChatsRelations = relations(subChats, ({ one }) => ({
  chat: one(chats, {
    fields: [subChats.chatId],
    references: [chats.id],
  }),
}));

// ============ AI ACCOUNT TYPES ============
export type AIAccountType = 'claude-code' | 'codex';

/**
 * Distinguishes how a credential row resolves its token at chat-time.
 * - `api-key`: encrypted token stored in `oauth_token`. Many rows allowed. Synced to Neon as encrypted blob.
 * - `claude-passthrough`: `oauth_token IS NULL`. Token resolved live from the keychain via `sourcePath`
 *   at every use. ONE row per machine. LOCAL-ONLY — never enqueued to `pendingAccountSyncs`.
 * - `codex-passthrough`: `oauth_token IS NULL`. The OpenAI Codex CLI owns its creds (OS keyring / `~/.codex`
 *   from `codex login`); Frink never stores an OpenAI key. Resolved live at spawn. LOCAL-ONLY.
 */
export type CredentialSource = 'api-key' | 'claude-passthrough' | 'codex-passthrough';

// ============ AGENT-PROVIDER CREDENTIALS (AI ACCOUNTS) ============
// SHARED across all coding-agent providers (Claude Code, OpenAI Codex). The table
// is still named `claude_code_credentials` for historical reasons — a rename is deferred to a ticket
// (no migration now, rule #4 notwithstanding: the column name is load-bearing for the live SQLite file).
// `type` distinguishes provider; `oauth_token` holds an OAuth token or API key, NULL for passthrough rows.
export const claudeCodeCredentials = sqliteTable(
  'claude_code_credentials',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    type: text('type').notNull().default('claude-code'), // AIAccountType: 'claude-code' | 'codex'
    accountLabel: text('account_label'), // "Work", "Personal", etc. (nullable for migration compat)
    oauthToken: text('oauth_token'), // Encrypted with safeStorage; NULL for placeholder accounts synced from cloud OR for `claude-passthrough` rows
    connectedAt: integer('connected_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    isDefault: integer('is_default', { mode: 'boolean' }).default(false), // Only one should be true
    // Local-only credential-source columns. Not mirrored to Neon.
    source: text('source').notNull().default('api-key'), // CredentialSource
    sourcePath: text('source_path'), // Platform-tagged URI for `claude-passthrough` rows
    expectedEmail: text('expected_email'), // Identity captured at connect-time; mismatch triggers needsReauthAt
    lastResolvedFromSourceAt: integer('last_resolved_from_source_at', { mode: 'timestamp' }),
    needsReauthAt: integer('needs_reauth_at', { mode: 'timestamp' }),
  },
  (table) => [
    // Credential lookups filter on provider/label, default selection and resolution source.
    index('ccc_type_label_idx').on(table.type, table.accountLabel),
    index('ccc_default_idx').on(table.isDefault),
    index('ccc_source_idx').on(table.source),
  ],
);

// ============ NODE CREDENTIALS ============
// Stores encrypted credentials for custom flow nodes.
// Scoped per node type (node_name) + credential key (declared in manifest.credentials).
// encrypted_value holds the raw secret, encrypted with safeStorage.
export const nodeCredentials = sqliteTable(
  'node_credentials',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    nodeName: text('node_name').notNull(),
    credentialKey: text('credential_key').notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex('nc_node_key_idx').on(table.nodeName, table.credentialKey)],
);

export type NodeCredential = typeof nodeCredentials.$inferSelect;
export type NewNodeCredential = typeof nodeCredentials.$inferInsert;

// ============ BACKFILL PROGRESS ============
// Shared by Phase 1 chats backfill and Phase 1.5 permissions backfill — do not re-declare.
// Migration 0064 created the SQL table; this declaration mirrors it for ORM access.
// Keys are namespaced strings: `chats:<chatId>`, `permissions:user:<userId>`.
export const backfillProgress = sqliteTable('_backfill_progress', {
  id: text('id').primaryKey(),
  completedAt: integer('completed_at', { mode: 'timestamp' }).notNull(),
});

// ============ V2 PERMISSION RULES ============
// Permissions overhaul ticket 06: rule-string storage for the v2 dispatcher.
// One row per rule. Rule strings are claude-code grammar (`Bash(git push:*)`,
// `Edit(src/**)`, `mcp__shortcut__*`). Local-only.
export const userPermissionRules = sqliteTable(
  'user_permission_rules',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    ruleString: text('rule_string').notNull(),
    ruleType: text('rule_type').notNull(), // 'allow' | 'deny' | 'ask' (CHECK in migration SQL)
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex('upr_unique_idx').on(table.ruleString, table.ruleType)],
);

export const projectPermissionRules = sqliteTable(
  'project_permission_rules',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ruleString: text('rule_string').notNull(),
    ruleType: text('rule_type').notNull(), // 'allow' | 'deny' | 'ask' (CHECK in migration SQL)
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('ppr_project_idx').on(table.projectId),
    uniqueIndex('ppr_unique_idx').on(table.projectId, table.ruleString, table.ruleType),
  ],
);

// ============ FLOWS ============
// Mirrors parked Neon migrations 0038, 0039, 0040, 0041, 0046, 0048 (lease cols skipped),
// 0050, 0051, 0055, 0056, 0058, 0059, 0060, 0061, 0043. Local-first: cuid2 IDs (not UUID).
// Every row belongs to the one owner of this userData directory; there is no identity column.
export const flows = sqliteTable(
  'flows',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
    agentInvocable: integer('agent_invocable', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => [index('flows_project_idx').on(table.projectId)],
);

// fallow-ignore-next-line code-duplication -- index lists, relations() and column builders repeat by construction.
export const flowsRelations = relations(flows, ({ one, many }) => ({
  project: one(projects, { fields: [flows.projectId], references: [projects.id] }),
  versions: many(flowVersions),
}));

// Immutable versioned graph snapshots. UNIQUE(flow_id, version_number) enforces sequential numbering.
export const flowVersions = sqliteTable(
  'flow_versions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    flowId: text('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    // JSON: { nodes: [...], edges: [...], settings: {...} }
    graph: text('graph', { mode: 'json' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('flow_versions_flow_version_uniq').on(table.flowId, table.versionNumber),
    index('flow_versions_flow_idx').on(table.flowId),
  ],
);

export const flowVersionsRelations = relations(flowVersions, ({ one, many }) => ({
  flow: one(flows, { fields: [flowVersions.flowId], references: [flows.id] }),
  runs: many(flowRuns),
}));

// Flow run = execution instance of a versioned graph.
export const flowRuns = sqliteTable(
  'flow_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    flowVersionId: text('flow_version_id')
      .notNull()
      .references(() => flowVersions.id, { onDelete: 'cascade' }),
    // 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
    status: text('status').notNull().default('pending'),
    triggerContext: text('trigger_context', { mode: 'json' }).$type<Record<string, unknown>>(),
    idempotencyKey: text('idempotency_key'),
    batchId: text('batch_id'),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => [
    // Partial unique idempotency_key (NULL repeats) = replay defence; never prune these rows.
    uniqueIndex('flow_runs_idempotency_uniq')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index('flow_runs_status_idx').on(table.status),
    index('flow_runs_version_created_idx').on(table.flowVersionId, table.createdAt),
    index('flow_runs_batch_idx').on(table.batchId),
  ],
);
export const flowRunsRelations = relations(flowRuns, ({ one, many }) => ({
  version: one(flowVersions, { fields: [flowRuns.flowVersionId], references: [flowVersions.id] }),
  nodeRuns: many(nodeRuns),
}));
export const flowRunAdmissions = defineFlowRunAdmissions(flowRuns);
// Per-node execution row. Block type CHECK constraint relaxed (validation is application-level).
// laneIndex / parentFanOutNodeRunId support parallel fan-out lanes (cloud 0050).
// socket_dispatch_lease_until / dispatch_machine_id (cloud 0048) intentionally omitted —
// single-process locally needs no lease.
export const nodeRuns = sqliteTable(
  'node_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    flowRunId: text('flow_run_id')
      .notNull()
      .references(() => flowRuns.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    blockType: text('block_type').notNull(),
    // 'pending' | 'running' | 'awaiting_input' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'skipped'
    status: text('status').notNull().default('pending'),
    nodeOutput: text('node_output', { mode: 'json' }),
    attemptNumber: integer('attempt_number').notNull().default(1),
    laneIndex: integer('lane_index'),
    parentFanOutNodeRunId: text('parent_fan_out_node_run_id'),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => [
    index('node_runs_flow_run_idx').on(table.flowRunId, table.status),
    index('node_runs_parent_fan_out_idx').on(table.parentFanOutNodeRunId),
    // Partial unique: only one running row per (flow_run, node, lane). NULL lane_index treated as
    // a distinct slot in SQLite by default — sequential runs can't double-run the same node either.
    uniqueIndex('node_runs_unique_running')
      .on(table.flowRunId, table.nodeId, table.laneIndex)
      .where(sql`status = 'running'`),
  ],
);

export const nodeRunsRelations = relations(nodeRuns, ({ one }) => ({
  run: one(flowRuns, { fields: [nodeRuns.flowRunId], references: [flowRuns.id] }),
}));

// Per-flow KV state — polling watermarks, dedup cursors, etc. (cloud 0043).
export const flowKvState = sqliteTable(
  'flow_kv_state',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    flowId: text('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).notNull().default('{}'),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex('flow_kv_state_uniq').on(table.flowId, table.key)],
);

// Briefing snapshots for context-switching between epics/batches (cloud 0056).
// sourceFlowId is metadata only; stashes outlive their source flow.
export const briefingStashes = sqliteTable(
  'briefing_stashes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text('name').notNull(),
    content: text('content').notNull(),
    sourceFlowId: text('source_flow_id').references(() => flows.id, { onDelete: 'set null' }),
    sourceFlowName: text('source_flow_name'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('briefing_stashes_created_idx').on(table.createdAt)],
);

// Reusable batch DAG topology templates (cloud 0060). schema_version guards against future drift.
export const batchPlanTemplates = sqliteTable(
  'batch_plan_templates',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text('name').notNull(),
    // JSON: [{stageNumber, name, dependsOn:[stageNumber,...]}, ...]
    stages: text('stages', { mode: 'json' }).notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    sourceFlowId: text('source_flow_id'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // Case-insensitive uniqueness via a lower() expression index (cloud uses LOWER(name)).
    uniqueIndex('batch_plan_templates_name_uniq').on(sql`lower(${table.name})`),
  ],
);

// Batch stages — DAG topology of a single batch instance (cloud 0058 + 0059).
export const batchStages = sqliteTable(
  'batch_stages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    batchId: text('batch_id').notNull(),
    stageNumber: integer('stage_number').notNull(),
    name: text('name'),
    // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
    status: text('status').notNull().default('pending'),
    failureThreshold: integer('failure_threshold').notNull().default(0),
    // JSON array of stage IDs this stage depends on. Empty = root.
    dependsOnStageIds: text('depends_on_stage_ids', { mode: 'json' }).notNull().default('[]'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('batch_stages_batch_stage_uniq').on(table.batchId, table.stageNumber),
    index('batch_stages_batch_idx').on(table.batchId),
  ],
);

// Per-stage flow run trigger record. flow_run_id nullable (set when run starts).
export const batchStageRuns = sqliteTable(
  'batch_stage_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    stageId: text('stage_id')
      .notNull()
      .references(() => batchStages.id, { onDelete: 'cascade' }),
    flowRunId: text('flow_run_id'),
    triggerContext: text('trigger_context', { mode: 'json' }),
    status: text('status').notNull().default('pending'),
    // Re-dispatch mode persisted on the row (not a call param) so EVERY dispatch path — the initial
    // synchronous pass AND the event-driven slot-fill / successor-promotion that pick up overflow and
    // downstream runs — restarts a from-beginning rerun at its start_task. Survives the async gap and a
    // process restart. Retained for DB compatibility; admission never auto-replays terminal runs.
    rerunFromBeginning: integer('rerun_from_beginning', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('batch_stage_runs_stage_status_idx').on(table.stageId, table.status),
    index('batch_stage_runs_flow_run_idx').on(table.flowRunId),
  ],
);

export const batchStagesRelations = relations(batchStages, ({ many }) => ({
  runs: many(batchStageRuns),
}));

export const batchStageRunsRelations = relations(batchStageRuns, ({ one }) => ({
  stage: one(batchStages, { fields: [batchStageRuns.stageId], references: [batchStages.id] }),
}));

// ============ TASKS ============
// Mirrors parked Neon migrations 0009, 0027, 0030, 0031, 0034, 0037, 0038, 0052.
// Local-first: cuid2 IDs. Heartbeat columns dropped (single-process: no cross-process lease needed).
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title'),
    description: text('description').notNull(),
    source: text('source').notNull(),
    sourceId: text('source_id'),
    executionTarget: text('execution_target').notNull().default('local'),
    requiresFilesystem: integer('requires_filesystem', { mode: 'boolean' })
      .notNull()
      .default(false),
    // 'pending' | 'running' | 'plan_ready' | 'needs_attention' | 'done' | 'completed' | 'failed' | 'cancelled'
    status: text('status').notNull().default('pending'),
    result: text('result', { mode: 'json' }),
    triggerContext: text('trigger_context', { mode: 'json' }),
    flowRunId: text('flow_run_id').references(() => flowRuns.id, { onDelete: 'set null' }),
    nodeRunId: text('node_run_id').references(() => nodeRuns.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    executedBy: text('executed_by'),
  },
  (table) => [
    index('tasks_status_created_idx').on(table.status, table.createdAt),
    index('tasks_executed_by_idx').on(table.executedBy),
    index('tasks_flow_run_idx').on(table.flowRunId),
    uniqueIndex('tasks_node_run_unique')
      .on(table.nodeRunId)
      .where(sql`${table.nodeRunId} IS NOT NULL`),
    uniqueIndex('tasks_idempotency_uniq')
      .on(table.source, table.sourceId)
      .where(sql`${table.sourceId} IS NOT NULL`),
  ],
);

export const tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  flowRun: one(flowRuns, { fields: [tasks.flowRunId], references: [flowRuns.id] }),
  nodeRun: one(nodeRuns, { fields: [tasks.nodeRunId], references: [nodeRuns.id] }),
}));

// ============ TRIGGER SOURCE GROUP ============
// trigger_type is ('post_task_trigger','schedule_trigger'); trigger_rules stays cloud (flagged).
export const flowTriggerBindings = sqliteTable(
  'flow_trigger_bindings',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    flowId: text('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    projectId: text('project_id'),
    // 'post_task_trigger' | 'schedule_trigger' (CHECK constraint enforces —
    // webhook_trigger rejected at repo insert).
    triggerType: text('trigger_type').notNull(),
    config: text('config', { mode: 'json' }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    lastError: text('last_error'),
    lastErrorAt: integer('last_error_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('flow_trigger_bindings_active_idx').on(table.isActive),
    index('flow_trigger_bindings_flow_idx').on(table.flowId),
    index('flow_trigger_bindings_type_active_idx').on(table.triggerType, table.isActive),
    uniqueIndex('flow_trigger_bindings_uq')
      .on(table.flowId, sql`COALESCE(${table.projectId}, '')`, table.triggerType)
      .where(sql`${table.isActive} = 1`),
  ],
);

// fallow-ignore-next-line code-duplication -- a table of id plus one foreign key matches every table of that shape.
export const flowTriggerBindingsRelations = relations(flowTriggerBindings, ({ one }) => ({
  flow: one(flows, { fields: [flowTriggerBindings.flowId], references: [flows.id] }),
}));

// ============ PROJECT AGENTS ============
// Phase 2 finish-list #3. Per-project enable/disable + config overrides for
// filesystem-discovered agents/skills/hooks. Replaces cloud project_agents.
// type CHECK constraint enforces ('agent','skill','hook') at DB level;
// composite UNIQUE prevents duplicate scope rows per (project, name, type).
export const projectAgents = sqliteTable(
  'project_agents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentName: text('agent_name').notNull(),
    // 'agent' | 'skill' | 'hook' (CHECK constraint enforces)
    type: text('type').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    configOverrides: text('config_overrides', { mode: 'json' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('project_agents_unique_idx').on(table.projectId, table.agentName, table.type),
    index('project_agents_project_idx').on(table.projectId),
    index('project_agents_enabled_idx')
      .on(table.projectId)
      .where(sql`${table.enabled} = 1`),
  ],
);

export const projectAgentsRelations = relations(projectAgents, ({ one }) => ({
  project: one(projects, { fields: [projectAgents.projectId], references: [projects.id] }),
}));

// ============ TYPE EXPORTS ============
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectAiAccount = typeof projectAiAccounts.$inferSelect;
export type NewProjectAiAccount = typeof projectAiAccounts.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type SubChat = typeof subChats.$inferSelect;
export type NewSubChat = typeof subChats.$inferInsert;
export type ClaudeCodeCredential = typeof claudeCodeCredentials.$inferSelect;
export type NewClaudeCodeCredential = typeof claudeCodeCredentials.$inferInsert;
export type BackfillProgress = typeof backfillProgress.$inferSelect;
export type NewBackfillProgress = typeof backfillProgress.$inferInsert;
export type UserPermissionRule = typeof userPermissionRules.$inferSelect;
export type NewUserPermissionRule = typeof userPermissionRules.$inferInsert;
export type ProjectPermissionRule = typeof projectPermissionRules.$inferSelect;
export type NewProjectPermissionRule = typeof projectPermissionRules.$inferInsert;
export type Flow = typeof flows.$inferSelect;
export type NewFlow = typeof flows.$inferInsert;
export type FlowVersion = typeof flowVersions.$inferSelect;
export type NewFlowVersion = typeof flowVersions.$inferInsert;
export type FlowRun = typeof flowRuns.$inferSelect;
export type NewFlowRun = typeof flowRuns.$inferInsert;
export type NodeRun = typeof nodeRuns.$inferSelect;
export type NewNodeRun = typeof nodeRuns.$inferInsert;
export type FlowKvState = typeof flowKvState.$inferSelect;
export type NewFlowKvState = typeof flowKvState.$inferInsert;
export type BriefingStash = typeof briefingStashes.$inferSelect;
export type NewBriefingStash = typeof briefingStashes.$inferInsert;
export type BatchPlanTemplate = typeof batchPlanTemplates.$inferSelect;
export type NewBatchPlanTemplate = typeof batchPlanTemplates.$inferInsert;
export type BatchStage = typeof batchStages.$inferSelect;
export type NewBatchStage = typeof batchStages.$inferInsert;
export type BatchStageRun = typeof batchStageRuns.$inferSelect;
export type NewBatchStageRun = typeof batchStageRuns.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type FlowTriggerBinding = typeof flowTriggerBindings.$inferSelect;
export type NewFlowTriggerBinding = typeof flowTriggerBindings.$inferInsert;
export type ProjectAgent = typeof projectAgents.$inferSelect;
export type NewProjectAgent = typeof projectAgents.$inferInsert;
export { appPreferences } from './app-preferences';
export { pluginInstallations } from './plugin-installations';
export { integrations, integrationWebhooks } from './webhook-ingress';
