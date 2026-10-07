import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FLOW_ADMISSION_LIVE_STATES } from '../../../src/shared/lib/flow-admission';
import { flowRunAdmissions } from '../../../src/main/lib/db/schema';
import { freshDb, type TestDb } from '../../../src/main/lib/db/test-utils/fresh-db';
import { listInterruptedRuns } from '../../../src/main/lib/trpc/routers/tasks-recovery';
import {
  CONTINUE_ALL_RUNS,
  continueAllIds,
  FIXTURE_CLAUDE_SOURCE_MARKER,
  FIXTURE_INTERRUPTED,
  fixtureSourceUri,
  seedFixtures,
} from '.';

const HOME = mkdtempSync(join(tmpdir(), 'qa-continue-all-'));
writeFileSync(join(HOME, FIXTURE_CLAUDE_SOURCE_MARKER), '');
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** A queued resume ticket among the seeded admission rows, as the runtime's probe reads them. */
const hasQueuedResume = (db: TestDb) => async (flowRunId: string) =>
  db
    .select()
    .from(flowRunAdmissions)
    .all()
    .some(
      (a) =>
        a.flowRunId === flowRunId &&
        a.priorityClass === 'resume' &&
        FLOW_ADMISSION_LIVE_STATES.some((state) => state === a.state && state !== 'active'),
    );

// The banner renders only what tasks.interruptedRuns returns, so a fixture row that silently drops
// out (wrong marker, a stray ticket, no recovery) would leave the QA screenshot empty.
describe('Continue all fixture', () => {
  it('lists every seeded run, oldest first, with the recovery the dialog sorts it into', async () => {
    const db = freshDb();
    seedFixtures(
      db,
      '/tmp/qa-fixture-checkout',
      fixtureSourceUri(join(HOME, FIXTURE_CLAUDE_SOURCE_MARKER)),
    );

    const rows = await listInterruptedRuns(db, hasQueuedResume(db));

    expect(rows.map((r) => r.taskId)).toEqual(
      CONTINUE_ALL_RUNS.map(({ key }) => continueAllIds(key).taskId),
    );
    expect(rows.map((r) => [r.projectName, r.recoveryKind, r.confirmSideEffects])).toEqual([
      ['QA Fixture', 'retry', false],
      ['QA Fixture', 'continue', false],
      ['QA Fixture', 'retry', true],
      ['QA Codex', 'retry', false],
    ]);
  });

  it('leaves out the interrupted chat fixture, whose resume ticket is already queued', async () => {
    const db = freshDb();
    seedFixtures(
      db,
      '/tmp/qa-fixture-checkout',
      fixtureSourceUri(join(HOME, FIXTURE_CLAUDE_SOURCE_MARKER)),
    );

    const rows = await listInterruptedRuns(db, hasQueuedResume(db));

    expect(rows.some((r) => r.flowRunId === FIXTURE_INTERRUPTED.runId)).toBe(false);
  });
});
