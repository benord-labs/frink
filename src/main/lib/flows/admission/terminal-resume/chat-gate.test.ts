import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { chats, flowRuns, flows, flowVersions, nodeRuns } from '../../../db/schema';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import type { FlowGraphNode } from '../../graph';
import { _resetFlowAdmissionControllerMutexForTests, FlowAdmissionController } from '../controller';
import { RESUME_CHAT_DELETED_MESSAGE, resumeChatDeleted } from './chat-gate';
import {
  ResumeAdmitDeclinedError,
  TerminalResumeAdmissionError,
  TerminalResumeChatDeletedError,
  terminalResumeAdmissionError,
} from './resume-store';

const RUN = 'run-1';

// st → fan ⟨ lst → lwork ⟩ → after (the sc-3836 shape: fan enters the lane, the lane tail exits it);
// work hangs straight off st.
const GRAPH = {
  nodes: [
    { id: 'st', blockType: 'start_task' },
    { id: 'work', blockType: 'agent' },
    { id: 'fan', blockType: 'fan_out' },
    { id: 'lst', blockType: 'start_task', parentId: 'fan' },
    { id: 'lwork', blockType: 'agent', parentId: 'fan' },
    { id: 'after', blockType: 'agent' },
  ] satisfies FlowGraphNode[],
  edges: [
    { id: 'e1', source: 'st', target: 'work' },
    { id: 'e2', source: 'st', target: 'fan' },
    { id: 'e3', source: 'fan', target: 'lst' },
    { id: 'e4', source: 'lst', target: 'lwork' },
    { id: 'e5', source: 'lwork', target: 'after' },
  ],
};

function seedRun(db: TestDb): void {
  db.insert(flows).values({ id: 'flow-1', name: 'Gate' }).run();
  db.insert(flowVersions)
    .values({ id: 'version-1', flowId: 'flow-1', versionNumber: 1, graph: GRAPH })
    .run();
  db.insert(flowRuns)
    .values({
      id: RUN,
      flowVersionId: 'version-1',
      status: 'failed',
      startedAt: new Date('2026-08-01T10:00:00Z'),
      completedAt: new Date('2026-08-01T10:05:00Z'),
    })
    .run();
}

function seedChat(db: TestDb, id: string, archived = false): void {
  db.insert(chats)
    .values({ id, name: id, archivedAt: archived ? new Date() : null })
    .run();
}

function seedNode(
  db: TestDb,
  id: string,
  nodeId: string,
  options: {
    status?: string;
    chatId?: string;
    lane?: { index: number; parent: string };
    completedAt?: Date;
  } = {},
): void {
  const blockType = GRAPH.nodes.find((n) => n.id === nodeId)?.blockType ?? 'agent';
  db.insert(nodeRuns)
    .values({
      id,
      flowRunId: RUN,
      nodeId,
      blockType,
      status: options.status ?? 'failed',
      completedAt: options.completedAt ?? (options.status === 'completed' ? new Date() : null),
      nodeOutput: options.chatId ? { outputs: { chatId: options.chatId } } : null,
      laneIndex: options.lane?.index,
      parentFanOutNodeRunId: options.lane?.parent,
    })
    .run();
}

function deleteChat(db: TestDb, id: string): void {
  db.delete(chats).where(eq(chats.id, id)).run();
}

let db: TestDb;

beforeEach(() => {
  _resetFlowAdmissionControllerMutexForTests();
  db = freshDb();
  seedRun(db);
  seedChat(db, 'chat-top');
  seedNode(db, 'nr-st', 'st', { status: 'completed', chatId: 'chat-top' });
});

describe('resumeChatDeleted', () => {
  it('refuses an anchor whose upstream start_task chat was deleted, and admits it while the chat exists', () => {
    seedNode(db, 'nr-work', 'work');
    expect(resumeChatDeleted(db, RUN, 'nr-work', 'version-1')).toBe(false);
    deleteChat(db, 'chat-top');
    expect(resumeChatDeleted(db, RUN, 'nr-work', 'version-1')).toBe(true);
  });

  it('still admits an archived chat (its row survives; archive is reversible)', () => {
    deleteChat(db, 'chat-top');
    seedChat(db, 'chat-top', true);
    seedNode(db, 'nr-work', 'work');
    expect(resumeChatDeleted(db, RUN, 'nr-work', 'version-1')).toBe(false);
  });

  it('never refuses an anchor AT the start_task — its retry provisions a fresh chat', () => {
    deleteChat(db, 'chat-top');
    seedNode(db, 'nr-st-retry', 'st');
    expect(resumeChatDeleted(db, RUN, 'nr-st-retry', 'version-1')).toBe(false);
  });

  it('never refuses a run with no completed start_task', () => {
    db.delete(nodeRuns).where(eq(nodeRuns.id, 'nr-st')).run();
    seedNode(db, 'nr-work', 'work');
    expect(resumeChatDeleted(db, RUN, 'nr-work', 'version-1')).toBe(false);
  });

  it("scopes a lane anchor to its own lane's chat, and an outer anchor to the outer chat", () => {
    seedNode(db, 'nr-fan', 'fan', { status: 'completed' });
    const lane = { index: 0, parent: 'nr-fan' };
    seedChat(db, 'chat-lane');
    seedNode(db, 'nr-lst', 'lst', { status: 'completed', chatId: 'chat-lane', lane });
    seedNode(db, 'nr-lwork', 'lwork', { lane });
    seedNode(db, 'nr-after', 'after');

    deleteChat(db, 'chat-lane');
    expect(resumeChatDeleted(db, RUN, 'nr-lwork', 'version-1')).toBe(true);
    expect(resumeChatDeleted(db, RUN, 'nr-after', 'version-1')).toBe(false);
  });
});

describe('resumeChatDeleted — which chat the anchor re-enters', () => {
  it("judges the NEWEST completed start_task attempt's chat, not an older attempt's", () => {
    // nr-st (chat-top) completed at seed time; a start_task re-run then provisioned chat-new.
    db.update(nodeRuns)
      .set({ completedAt: new Date('2026-08-01T10:00:00Z') })
      .where(eq(nodeRuns.id, 'nr-st'))
      .run();
    seedChat(db, 'chat-new');
    seedNode(db, 'nr-st-2', 'st', {
      status: 'completed',
      chatId: 'chat-new',
      completedAt: new Date('2026-08-01T11:00:00Z'),
    });
    seedNode(db, 'nr-work', 'work');

    deleteChat(db, 'chat-top');
    expect(resumeChatDeleted(db, RUN, 'nr-work', 'version-1')).toBe(false);
    seedChat(db, 'chat-top');
    deleteChat(db, 'chat-new');
    expect(resumeChatDeleted(db, RUN, 'nr-work', 'version-1')).toBe(true);
  });

  it("falls back to the outer start_task's chat for a lane anchor whose lane has no completed start_task", () => {
    seedNode(db, 'nr-fan', 'fan', { status: 'completed' });
    seedNode(db, 'nr-lwork', 'lwork', { lane: { index: 0, parent: 'nr-fan' } });

    expect(resumeChatDeleted(db, RUN, 'nr-lwork', 'version-1')).toBe(false);
    deleteChat(db, 'chat-top');
    expect(resumeChatDeleted(db, RUN, 'nr-lwork', 'version-1')).toBe(true);
  });

  it('admits a start_task whose output carries no chatId (empty or absent)', () => {
    deleteChat(db, 'chat-top');
    db.update(nodeRuns)
      .set({ nodeOutput: { outputs: { chatId: '' } } })
      .where(eq(nodeRuns.id, 'nr-st'))
      .run();
    seedNode(db, 'nr-work', 'work');
    expect(resumeChatDeleted(db, RUN, 'nr-work', 'version-1')).toBe(false);
  });

  it('fails open — leaving the error to dispatch — for a missing anchor, version, or unparseable graph', () => {
    deleteChat(db, 'chat-top');
    seedNode(db, 'nr-work', 'work');
    expect(resumeChatDeleted(db, RUN, 'no-such-node-run', 'version-1')).toBe(false);
    expect(resumeChatDeleted(db, RUN, 'nr-work', 'no-such-version')).toBe(false);
    db.update(flowVersions)
      .set({ graph: { nodes: 'not-an-array' } })
      .where(eq(flowVersions.id, 'version-1'))
      .run();
    expect(resumeChatDeleted(db, RUN, 'nr-work', 'version-1')).toBe(false);
  });
});

describe('terminalResumeAdmissionError — the string a failed ticket carries, retyped', () => {
  it('restores the deleted-chat refusal and leaves every other reason generic', () => {
    const deleted = terminalResumeAdmissionError(RESUME_CHAT_DELETED_MESSAGE);
    expect(deleted).toBeInstanceOf(TerminalResumeChatDeletedError);
    expect(deleted.message).toBe(RESUME_CHAT_DELETED_MESSAGE);

    const other = terminalResumeAdmissionError('Flow resume admission cancelled before dispatch');
    expect(other).toBeInstanceOf(TerminalResumeAdmissionError);
    expect(other).not.toBeInstanceOf(TerminalResumeChatDeletedError);
  });
});

describe('terminal resume admission with a deleted chat', () => {
  function controller(): FlowAdmissionController {
    return new FlowAdmissionController(db, async () => ({
      version: 1,
      queuePaused: false,
      concurrencyLimitEnabled: true,
      maxConcurrentRuns: 1,
    }));
  }

  it('refuses the enqueue with the plain copy and writes no ticket', async () => {
    seedNode(db, 'nr-work', 'work');
    deleteChat(db, 'chat-top');

    const attempt = controller().enqueueTerminalResume({ flowRunId: RUN, nodeRunId: 'nr-work' });

    await expect(attempt).rejects.toBeInstanceOf(TerminalResumeChatDeletedError);
    await expect(attempt).rejects.toThrow(RESUME_CHAT_DELETED_MESSAGE);
    expect(await controller().getLiveForRun(RUN)).toBeNull();
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, RUN)).get()?.status).toBe('failed');
  });

  it("lets the caller's own admit refusal win over a deleted chat (a cleared marker reads as the user's cancel)", async () => {
    seedNode(db, 'nr-work', 'work');
    deleteChat(db, 'chat-top');

    const attempt = controller().enqueueTerminalResume({
      flowRunId: RUN,
      nodeRunId: 'nr-work',
      admit: () => false,
    });

    await expect(attempt).rejects.toBeInstanceOf(ResumeAdmitDeclinedError);
    await expect(attempt).rejects.not.toBeInstanceOf(TerminalResumeChatDeletedError);
  });

  it('refuses a Retry (continuation) and a Re-run (redispatch) alike', async () => {
    seedNode(db, 'nr-work', 'work');
    deleteChat(db, 'chat-top');
    for (const continuation of [true, undefined] as const) {
      await expect(
        controller().enqueueTerminalResume({ flowRunId: RUN, nodeRunId: 'nr-work', continuation }),
      ).rejects.toBeInstanceOf(TerminalResumeChatDeletedError);
    }
  });

  it('admits a resume again once the chat row exists (refusal leaves nothing behind to clear)', async () => {
    seedNode(db, 'nr-work', 'work');
    deleteChat(db, 'chat-top');
    await expect(
      controller().enqueueTerminalResume({ flowRunId: RUN, nodeRunId: 'nr-work' }),
    ).rejects.toBeInstanceOf(TerminalResumeChatDeletedError);

    seedChat(db, 'chat-top', true);
    const admitted = await controller().enqueueTerminalResume({
      flowRunId: RUN,
      nodeRunId: 'nr-work',
    });
    expect(admitted.created).toBe(true);
  });

  it('fails a queued ticket whose chat is deleted before promotion, leaving the run terminal', async () => {
    seedNode(db, 'nr-work', 'work');
    const admissions = controller();
    const queued = await admissions.enqueueTerminalResume({ flowRunId: RUN, nodeRunId: 'nr-work' });
    const [claimed] = (await admissions.claimEligible()).admissions;
    deleteChat(db, 'chat-top');

    await expect(admissions.beginDispatch(claimed.ticket)).resolves.toBeNull();
    expect(await admissions.getByTicket(queued.admission.ticket)).toMatchObject({
      state: 'failed',
      error: RESUME_CHAT_DELETED_MESSAGE,
    });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, RUN)).get()?.status).toBe('failed');
  });
});
