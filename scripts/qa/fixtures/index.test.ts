import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { probeClaudePassthroughSource } from '../../../src/main/lib/credentials/source-readers';
import type { TestDb } from '../../../src/main/lib/db/test-utils/fresh-db';
import {
  chats,
  claudeCodeCredentials,
  flowRunAdmissions,
  flowRuns,
  flowVersions,
  nodeRuns,
  projects,
  projectAiAccounts,
  subChatMessages,
  subChats,
  tasks,
} from '../../../src/main/lib/db/schema';
import { freshDb } from '../../../src/main/lib/db/test-utils/fresh-db';
import { terminalFlowResumeIntent } from '../../../src/main/lib/flows/admission/terminal-resume/resume-store';
import { CODEX_FIXTURE } from './codex';
import { RESTART_INTERRUPTION_REASON } from '../../../src/shared/types/flow';
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_CHAT_SEEDED_ID,
  FIXTURE_FLOW_CHAT_ID,
  FIXTURE_FLOW_TASK_DONE_ID,
  FIXTURE_FLOW_TASK_PARKED_ID,
  FIXTURE_HISTORY_CANCELLED_ID,
  FIXTURE_HISTORY_COMPLETED_ID,
  FIXTURE_INTERRUPTED,
  FIXTURE_PLUGIN_NODE_FLOW_ID,
  FIXTURE_CALL_TOOL_NODE_NAME,
  FIXTURE_MCP_CONFIG,
  FIXTURE_PLUGIN_NODE_NAME,
  FIXTURE_PROJECT_ID,
  FIXTURE_QUEUED_RESUME_RUN_ID,
  FIXTURE_QUEUED_START_RUN_ID,
  FIXTURE_RUNNING_CHAT_ID,
  FIXTURE_RUNNING_MODEL_ID,
  FIXTURE_RUNNING_RUN_ID,
  FIXTURE_RUNNING_TASK_ID,
  FIXTURE_SUB_CHAT_ID,
  FIXTURE_TASK_ID,
  FIXTURE_CLAUDE_SOURCE_MARKER,
  fixtureSourceUri,
  seedFixtures,
  verifyFixtures,
} from '.';

// Verification checks the source file is really there, so the suite seeds against a real one.
const CLAUDE_SOURCE_HOME = mkdtempSync(join(tmpdir(), 'qa-fixture-home-'));
const CLAUDE_SOURCE = fixtureSourceUri(join(CLAUDE_SOURCE_HOME, FIXTURE_CLAUDE_SOURCE_MARKER));
writeFileSync(join(CLAUDE_SOURCE_HOME, FIXTURE_CLAUDE_SOURCE_MARKER), '');
afterAll(() => rmSync(CLAUDE_SOURCE_HOME, { recursive: true, force: true }));

type QaFixtureArtifactData = {
  version: 1;
  artifactId: string;
  title: string;
  bodyHtml?: string;
};

type QaFixtureMessage = {
  id: string;
  role: string;
  parts?: Array<{ type: string; text?: string; data?: QaFixtureArtifactData }>;
};

// Guards the QA seed against schema drift: if a migration adds a constraint the
// fixtures don't satisfy, this fails as "seed is stale" instead of surfacing as
// a blank QA screen at vision-run time.
describe('qa seed fixtures', () => {
  it('inserts the fixture workspace against the live schema', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);

    expect(verifyFixtures(db).ok).toBe(true);

    const [project] = db.select().from(projects).all();
    expect(project?.id).toBe(FIXTURE_PROJECT_ID);
    expect(project?.path).toBe('/tmp/qa-fixture-checkout');

    // Empty chat + seeded chat + long transcript + the parked-flow, paused-flow, running-flow,
    // interrupted-flow, two batch-member and three background-work chats under the fixture project,
    // plus the Codex chat.
    const chatRows = db.select().from(chats).all();
    expect(chatRows.filter((c) => c.projectId === FIXTURE_PROJECT_ID)).toHaveLength(12);
    expect(chatRows.filter((c) => c.projectId === CODEX_FIXTURE.projectId)).toHaveLength(1);

    const [subChat] = db.select().from(subChats).all();
    expect(subChat?.id).toBe(FIXTURE_SUB_CHAT_ID);
    expect(subChat?.chatId).toBe(FIXTURE_CHAT_SEEDED_ID);
    // SAFETY: seedFixtures persists this fixture-owned JSON; the assertions below pin its shape.
    const messages = db
      .select()
      .from(subChatMessages)
      .where(eq(subChatMessages.subChatId, FIXTURE_SUB_CHAT_ID))
      .orderBy(subChatMessages.seq)
      .all()
      .map((row) => JSON.parse(row.message) as QaFixtureMessage);
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'user',
      'assistant',
    ]);

    const digest = messages.find(
      (message) => message.id === 'qa-fixture-msg-assistant-customer-digest',
    );
    const artifact = digest?.parts?.find((part) => part.type === 'data-html-artifact');
    expect(artifact?.data).toMatchObject({
      version: 1,
      artifactId: 'qa-fixture-customer-message-digest',
      title: 'Customer message digest · 18–22 Aug',
    });
    const bodyHtml = artifact?.data?.bodyHtml ?? '';
    expect(bodyHtml.match(/ data-message data-theme=/g)).toHaveLength(4);
    expect(bodyHtml).toContain('Northstar Studios');
  });

  it('is idempotent — a second seed leaves the same single workspace', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);
    expect(verifyFixtures(db).ok).toBe(true);
  });

  it('seeds the plan_ready task and the parked flow', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);

    expect(verifyFixtures(db).ok).toBe(true);

    const taskRows = db.select().from(tasks).all();
    // plan_ready + completed/cancelled History examples + 2 parked-flow + paused/running/interrupted.
    expect(taskRows).toHaveLength(8);

    // plan_ready (not running): survives the boot-time orphan-task recovery and is never auto-run.
    expect(taskRows.find((t) => t.id === FIXTURE_TASK_ID)?.status).toBe('plan_ready');
    expect(taskRows.find((t) => t.id === FIXTURE_HISTORY_COMPLETED_ID)?.status).toBe('completed');
    expect(taskRows.find((t) => t.id === FIXTURE_HISTORY_CANCELLED_ID)?.status).toBe('cancelled');

    // The link that makes the seeded chat's delete task-aware (destructive confirm dialog).
    const seededChat = db
      .select()
      .from(chats)
      .all()
      .find((c) => c.id === FIXTURE_CHAT_SEEDED_ID);
    expect(seededChat?.taskId).toBe(FIXTURE_TASK_ID);
  });

  it('seeds an authenticated default account so the chat surface clears its account gate', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);

    const [account] = db.select().from(claudeCodeCredentials).all();
    expect(account?.id).toBe(FIXTURE_ACCOUNT_ID);
    // The exact shape getResolvedAccount/listAccounts read as an authenticated, selectable default:
    // claude-passthrough is authenticated by needsReauthAt IS NULL (no token to encrypt), claude-code
    // is always selectable, and isDefault makes it the resolved account.
    expect(account?.type).toBe('claude-code');
    expect(account?.source).toBe('claude-passthrough');
    expect(account?.oauthToken).toBeNull();
    expect(account?.needsReauthAt).toBeNull();
    expect(account?.isDefault).toBe(true);
    expect(account?.sourcePath).toBe(CLAUDE_SOURCE);
  });

  it('seeds a Claude source the real presence probe finds, even under a path with spaces', async () => {
    // The rig home sits under "Application Support", so the space is the realistic case.
    const home = mkdtempSync(join(tmpdir(), 'qa fixture home-'));
    try {
      const marker = join(home, FIXTURE_CLAUDE_SOURCE_MARKER);
      writeFileSync(marker, '');
      const db = freshDb();
      seedFixtures(db, '/tmp/qa-fixture-checkout', fixtureSourceUri(marker));
      const account = db
        .select()
        .from(claudeCodeCredentials)
        .all()
        .find((a) => a.id === FIXTURE_ACCOUNT_ID);

      await expect(probeClaudePassthroughSource(account?.sourcePath ?? '')).resolves.toEqual({
        ok: true,
      });

      // Negative control: the same row stops resolving once the marker is gone.
      rmSync(marker);
      await expect(probeClaudePassthroughSource(account?.sourcePath ?? '')).resolves.toMatchObject({
        error: 'missing',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails verification when the Claude account has no source for the probe to find', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);
    expect(verifyFixtures(db).ok).toBe(true);

    db.update(claudeCodeCredentials)
      .set({ sourcePath: null })
      .where(eq(claudeCodeCredentials.id, FIXTURE_ACCOUNT_ID))
      .run();
    expect(verifyFixtures(db).ok).toBe(false);

    // A source that names a file nobody wrote is flagged exactly like a missing one.
    db.update(claudeCodeCredentials)
      .set({ sourcePath: fixtureSourceUri(join(CLAUDE_SOURCE_HOME, 'never-written')) })
      .where(eq(claudeCodeCredentials.id, FIXTURE_ACCOUNT_ID))
      .run();
    expect(verifyFixtures(db).ok).toBe(false);

    // A keychain source would resolve only where the operator is signed in to Claude.
    db.update(claudeCodeCredentials)
      .set({ sourcePath: 'darwin-keychain://Claude%20Code-credentials' })
      .where(eq(claudeCodeCredentials.id, FIXTURE_ACCOUNT_ID))
      .run();
    expect(verifyFixtures(db).ok).toBe(false);
  });

  it('seeds a separate Codex project with stable routing and no stored token', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);
    const account = db
      .select()
      .from(claudeCodeCredentials)
      .all()
      .find((a) => a.id === CODEX_FIXTURE.accountId);
    expect(account).toMatchObject({
      type: 'codex',
      source: 'codex-passthrough',
      oauthToken: null,
      needsReauthAt: null,
      isDefault: false,
      connectedAt: new Date('2026-01-01T10:00:00Z'),
    });
    expect(db.select().from(projectAiAccounts).all()).toEqual([
      {
        projectId: CODEX_FIXTURE.projectId,
        accountId: CODEX_FIXTURE.accountId,
        createdAt: new Date('2026-01-01T10:00:00Z'),
      },
    ]);
    expect(
      db
        .select()
        .from(subChats)
        .all()
        .find((c) => c.id === CODEX_FIXTURE.subChatId),
    ).toMatchObject({ chatId: CODEX_FIXTURE.chatId, sessionId: null });
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);
    expect(verifyFixtures(db).ok).toBe(true);
    expect(db.select().from(claudeCodeCredentials).all()).toHaveLength(2);
  });

  it('rejects a Codex fixture whose project falls back to the Claude default', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);
    db.delete(projectAiAccounts).run();
    expect(verifyFixtures(db).ok).toBe(false);
  });

  it('seeds the parked-flow fixture whose card resolves by sub-chat', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);

    const taskRows = db.select().from(tasks).all();
    // plan_ready + 2 History + 2 parked-flow + paused-flow + running-flow + interrupted-flow
    expect(taskRows).toHaveLength(8);
    expect(taskRows.some((t) => t.id === FIXTURE_TASK_ID)).toBe(true);

    // First node terminal, later node parked — ParkedQuestionsBar must resolve the LATER (driving) one.
    expect(taskRows.find((t) => t.id === FIXTURE_FLOW_TASK_DONE_ID)?.status).toBe('done');
    const parked = taskRows.find((t) => t.id === FIXTURE_FLOW_TASK_PARKED_ID);
    expect(parked?.status).toBe('needs_attention');
    const signal = (
      parked?.result as { agentSignal?: { state?: string; questions?: unknown[] } } | null
    )?.agentSignal;
    expect(signal?.state).toBe('awaiting_input');
    expect(signal?.questions?.length).toBeGreaterThan(0);

    // The flow chat is pinned to the DONE first node — the bug scenario the fix must see past.
    const flowChat = db
      .select()
      .from(chats)
      .all()
      .find((c) => c.id === FIXTURE_FLOW_CHAT_ID);
    expect(flowChat?.taskId).toBe(FIXTURE_FLOW_TASK_DONE_ID);
  });

  it('seeds a running-flow fixture that derives to the running strip (done task under a live run)', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);

    const running = db
      .select()
      .from(tasks)
      .all()
      .find((t) => t.id === FIXTURE_RUNNING_TASK_ID);
    // `done` (NOT `running`) is deliberate: a running task/run is swept terminal at boot, and a
    // cancelled task under a live run derives to the composer — so the strip is only reachable via a
    // terminal task under a still-live run. A regression that "fixes" this to running kills the strip.
    expect(running?.status).toBe('done');
    expect(running?.flowRunId).toBe(FIXTURE_RUNNING_RUN_ID);
    // The model/mode pills read from _config; without them the strip renders no readout.
    const config = (running?.triggerContext as { _config?: { model?: string; startMode?: string } })
      ?._config;
    expect(config?.model).toBe(FIXTURE_RUNNING_MODEL_ID);
    expect(config?.startMode).toBe('agent');
  });

  it('seeds both queued admission classes, with the start row as a batch member', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);

    const queued = db
      .select()
      .from(flowRunAdmissions)
      .all()
      .filter((a) => a.state === 'queued');
    expect(queued.map((a) => a.priorityClass).sort()).toEqual(['resume', 'resume', 'start']);
    const runs = db.select().from(flowRuns).all();
    // The start row never ran, so removing it cancels a run; the resume row's run is already
    // terminal and survives its own removal. Both branches of the confirm copy need one each.
    expect(runs.find((r) => r.id === FIXTURE_QUEUED_START_RUN_ID)?.status).toBe('pending');
    expect(runs.find((r) => r.id === FIXTURE_QUEUED_RESUME_RUN_ID)?.status).toBe('failed');
    // batchId is what makes the dialog state the batch-stage consequence.
    expect(runs.find((r) => r.id === FIXTURE_QUEUED_START_RUN_ID)?.batchId).toBeTruthy();
  });

  it('fails verification when a running-flow LINK drifts, not just when a row goes missing', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);
    expect(verifyFixtures(db).ok).toBe(true);

    // Break ONLY the chat -> task pin. Every row still exists and every count still matches, so an
    // existence-only check would pass while the chat would actually render the composer — the
    // silent half-seed that wastes a whole vision drive.
    db.update(chats).set({ taskId: null }).where(eq(chats.id, FIXTURE_RUNNING_CHAT_ID)).run();
    expect(verifyFixtures(db).ok).toBe(false);
  });

  it('seeds every task and chat the visual surfaces need', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);
    expect(db.select().from(tasks).all()).toHaveLength(8);
    expect(db.select().from(chats).all()).toHaveLength(13);
  });

  // The interrupted fixture is the only way any QA run can reach InterruptedRunControls, and each of
  // its four rows fails SILENTLY on its own — so pin the two that decide what the user sees.
  it('seeds a restart-interrupted run whose marker makes the recovery row render', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);
    expect(verifyFixtures(db).ok).toBe(true);

    // The marker is what separates a recoverable interruption from a deliberate Stop.
    const nodeRun = db
      .select()
      .from(nodeRuns)
      .all()
      .find((n) => n.id === FIXTURE_INTERRUPTED.nodeRunId);
    const error = (nodeRun?.nodeOutput as { error?: { message?: string } } | null)?.error;
    expect(error?.message).toBe(RESTART_INTERRUPTION_REASON);

    // Without the marker the row vanishes entirely — no CTA for the vision run to photograph.
    db.update(nodeRuns)
      .set({ nodeOutput: { status: 'cancelled', outputs: {}, artifacts: [], durationMs: 0 } })
      .where(eq(nodeRuns.id, FIXTURE_INTERRUPTED.nodeRunId))
      .run();
    expect(verifyFixtures(db).ok).toBe(false);
  });

  // Re-running the interrupted node resolves its blockType from the stored graph, so a ReactFlow
  // shaped stub ({type, data}) inserts a null block_type and the click fails with a DB error toast
  // that reads exactly like a product bug. Pin the engine shape and the id the node_run points at.
  it('stores an engine-shaped graph the interrupted node can actually be re-run from', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);

    const version = db
      .select()
      .from(flowVersions)
      .all()
      .find((v) => v.id === FIXTURE_INTERRUPTED.versionId);
    const graph = version?.graph as { nodes?: { id?: string; blockType?: string }[] } | null;
    const nodeRun = db
      .select()
      .from(nodeRuns)
      .all()
      .find((n) => n.id === FIXTURE_INTERRUPTED.nodeRunId);

    const node = graph?.nodes?.find((n) => n.id === nodeRun?.nodeId);
    expect(node?.blockType).toBe('agent');
  });

  it('fails verification when the interrupted sub-chat loses its session', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout', CLAUDE_SOURCE);

    // A session-less sub-chat still renders a row, but one that can only ever "Retry" — a
    // silently different surface from the session-resumable run this fixture stands for.
    db.update(subChats)
      .set({ sessionId: null })
      .where(eq(subChats.id, FIXTURE_INTERRUPTED.subChatId))
      .run();
    expect(verifyFixtures(db).ok).toBe(false);
  });

  // A stale key makes the strict reader reject the ticket: a recovery click then throws instead
  // of joining it, and a drain fails the run as an unsupported intent.
  it('seeds the interrupted run a resume ticket a recovery click can join', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-fixture-checkout');

    const ticket = db
      .select()
      .from(flowRunAdmissions)
      .all()
      .find((a) => a.flowRunId === FIXTURE_INTERRUPTED.runId);
    expect(terminalFlowResumeIntent(ticket?.intentJson)?.node_run_id).toBe(
      FIXTURE_INTERRUPTED.nodeRunId,
    );
  });
});

// The derivation reads the rig's seeded MCP config and the seeded schema row; both are replaced here
// with the fixture values seed-db.ts writes, so this test proves what the QA app will list.
type DbSlot = { current: TestDb | null };
const derivationState = vi.hoisted(() => {
  const db: DbSlot = { current: null };
  return { db };
});
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../src/main/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/lib/db')>()),
  getDatabase: () => {
    if (!derivationState.db.current) throw new Error('fixture database not seeded');
    return derivationState.db.current;
  },
}));
// The rig's seeded config replaces the operator's ~/.frink/mcp/config.json read.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../src/main/lib/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/lib/mcp')>()),
  readMcpConfigSync: () => FIXTURE_MCP_CONFIG,
}));

describe('plugin-node flow fixture', () => {
  it('seeds a flow whose PostHog step names the fixture manifest', () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-project', CLAUDE_SOURCE);
    const version = db
      .select()
      .from(flowVersions)
      .where(eq(flowVersions.flowId, FIXTURE_PLUGIN_NODE_FLOW_ID))
      .get();
    // SAFETY: the fixture wrote this graph one call above; only its node list is read.
    const graph = version?.graph as { nodes: Array<{ blockType: string; label?: string }> };
    expect(graph.nodes.map((node) => node.blockType)).toEqual([
      'manual_trigger',
      FIXTURE_PLUGIN_NODE_NAME,
      FIXTURE_CALL_TOOL_NODE_NAME,
    ]);
  });

  it('derives exactly the two PostHog steps from the seeded config entry and schema row', async () => {
    const db = freshDb();
    seedFixtures(db, '/tmp/qa-project', CLAUDE_SOURCE);
    derivationState.db.current = db;
    const { listPluginNodes } =
      await import('../../../src/main/lib/integrations/plugin-node-derivation');
    const nodes = listPluginNodes('posthog');
    expect(nodes.map((node) => node.name).sort()).toEqual(
      [FIXTURE_CALL_TOOL_NODE_NAME, FIXTURE_PLUGIN_NODE_NAME].sort(),
    );
    expect(nodes.find((node) => node.name === FIXTURE_PLUGIN_NODE_NAME)).toMatchObject({
      inputs: { dateRange: { type: 'json' } },
      unsupportedFields: ['assignee', 'filterGroup'],
    });
    expect(nodes.find((node) => node.name === FIXTURE_CALL_TOOL_NODE_NAME)).toMatchObject({
      source: { type: 'provider_mcp', serverId: 'posthog' },
      inputs: { tool: { required: true }, arguments: { type: 'json' } },
    });
    // Registered but credential-less: the derivation lists it while the picker still reports not connected.
    expect(FIXTURE_MCP_CONFIG.servers.plugin_posthog_posthog.managedBy).toBe('vendor_plugin');
  });
});
