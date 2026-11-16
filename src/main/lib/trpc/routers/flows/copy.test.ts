import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as analytics from '../../../analytics';
import * as database from '../../../db';
import * as flowVersions from '../../../db/repos/flow-versions';
import { createFlowVersion } from '../../../db/repos/flow-versions';
import * as flowsRepo from '../../../db/repos/flows';
import { createFlow, getFlowById } from '../../../db/repos/flows';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import { router } from '../../index';
import { createFlowCopyProcedures } from './copy';

let db: TestDb;
vi.spyOn(database, 'getDatabase').mockImplementation(() => db);
const trackFlowCreated = vi.spyOn(analytics, 'trackFlowCreated');

const caller = router(createFlowCopyProcedures()).createCaller({ getWindow: () => null });

describe('flows.copy usage count', () => {
  beforeEach(() => {
    db = freshDb();
    trackFlowCreated.mockClear();
  });

  it('counts the copy as a new Flow, with how it starts', async () => {
    const source = await createFlow(db, { name: 'F' });
    await createFlowVersion(db, {
      flowId: source.id,
      graph: { nodes: [{ id: 't', blockType: 'schedule_trigger' }], edges: [] },
    });

    const copy = await caller.copy({ id: source.id });

    expect(trackFlowCreated.mock.calls).toEqual([
      [{ id: copy.id, triggerType: 'schedule', createdBy: 'copy' }],
    ]);
  });

  it('counts nothing when the copy is refused', async () => {
    const unsaved = await createFlow(db, { name: 'Draft' });

    await expect(caller.copy({ id: unsaved.id })).rejects.toThrow('Save the flow before copying.');
    await expect(caller.copy({ id: 'missing' })).rejects.toThrow('Flow not found');
    expect(trackFlowCreated).not.toHaveBeenCalled();
  });

  it('returns the copy when the read after it fails', async () => {
    const source = await createFlow(db, { name: 'F' });
    await createFlowVersion(db, { flowId: source.id, graph: { nodes: [], edges: [] } });
    const read = vi
      .spyOn(flowVersions, 'getLatestVersion')
      .mockRejectedValueOnce(new Error('read failed'));

    try {
      const copy = await caller.copy({ id: source.id });

      expect(read).toHaveBeenCalledOnce();
      expect(await getFlowById(db, copy.id)).not.toBeNull();
      expect(trackFlowCreated).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('returns the copy when counting it fails', async () => {
    const source = await createFlow(db, { name: 'F' });
    await createFlowVersion(db, { flowId: source.id, graph: { nodes: [], edges: [] } });
    trackFlowCreated.mockImplementationOnce(() => {
      throw new Error('capture failed');
    });

    const copy = await caller.copy({ id: source.id });

    expect(trackFlowCreated).toHaveBeenCalledOnce();
    expect(await getFlowById(db, copy.id)).not.toBeNull();
  });

  it('still reports an unexpected copy failure as failed, and counts nothing', async () => {
    const source = await createFlow(db, { name: 'F' });
    const copyFlow = vi
      .spyOn(flowsRepo, 'copyFlow')
      .mockRejectedValueOnce(new Error('disk I/O error'));

    try {
      await expect(caller.copy({ id: source.id })).rejects.toThrow('Could not copy flow');
      expect(trackFlowCreated).not.toHaveBeenCalled();
    } finally {
      copyFlow.mockRestore();
    }
  });
});
