import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask, updateTaskStatus } from '../db/repos/tasks';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

// The pause path reads its db via the getDatabase() singleton; point it at the
// per-test in-memory db. The dispatch side is stubbed — parking needs no node.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('./advance', () => ({
  loadRunContext: vi.fn(),
  dispatchAndAdvance: vi.fn(),
  advanceFlowRun: vi.fn(),
}));

import { subscribeFlowEvents } from './events';
import { pauseFlowRunForSubChat } from './resume';
import { mapTaskToNodeOutput } from './signal-bridge';

/**
 * A user's own Pause must never ding them with the 'parked' sound. That takes
 * two guarantees, pinned separately here: the synchronous park emits nothing,
 * and the LATER watcher-driven advance (which DOES emit run_paused for this
 * park) carries the userPaused marker the renderer silences on.
 */
describe('pauseFlowRunForSubChat — self-pause stays silent end to end', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
    holder.db = db;
  });

  async function seedRunningPauseTask() {
    const task = await createTask(db, {
      description: 'agent',
      source: 'flow',
      result: { subChatId: 'sc-pause' },
    });
    await updateTaskStatus(db, task.id, 'running', { result: { subChatId: 'sc-pause' } });
    return task;
  }

  it('the synchronous park emits no flow event', async () => {
    await seedRunningPauseTask();
    const events: string[] = [];
    const unsubscribe = subscribeFlowEvents((e) => events.push(e.eventType));
    try {
      const result = await pauseFlowRunForSubChat('sc-pause', () => true);
      expect(result.paused).toBe(true);
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('the parked task maps to an awaiting_input output CARRYING the userPaused marker', async () => {
    const task = await seedRunningPauseTask();
    await pauseFlowRunForSubChat('sc-pause', () => true);

    // The watcher later feeds this output to advanceFlowRun, whose
    // run_paused event stamps pauseKind 'user' from it (see advance.test.ts) —
    // the renderer's flowEventSound silences exactly that marker.
    const { getTaskById } = await import('../db/repos/tasks');
    const parked = await getTaskById(db, task.id);
    expect(parked?.status).toBe('needs_attention');
    const output = mapTaskToNodeOutput(parked as never);
    expect(output.status).toBe('awaiting_input');
    expect(output.userPaused).toBe(true);
  });
});
