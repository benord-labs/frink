import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeFlowFile } from '../../../../../shared/lib/flows/flow-file';
import type { FlowGraphInput } from '../../../../../shared/types/flow-graph-schema';
import * as analytics from '../../../analytics';
import * as database from '../../../db';
import { listForFlow } from '../../../db/repos/flow-trigger-bindings';
import { createFlowVersion, getLatestVersion } from '../../../db/repos/flow-versions';
import { createFlow, getFlowById, listFlows } from '../../../db/repos/flows';
import { createProject } from '../../../db/repos/projects';
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
});

const RELEASE: FlowGraphInput = {
  nodes: [
    { id: 't', blockType: 'manual_trigger' },
    { id: 'build', blockType: 'run_command', config: { command: 'make', projectId: 'api-a' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'build' }],
  settings: { defaultProjectId: 'api-a' },
};

function flowFile(graph: FlowGraphInput): string {
  return serializeFlowFile({ name: 'Release', description: 'Ships it', graph }, [
    { id: 'api-a', name: 'api' },
  ]);
}

describe('flows.importFile', () => {
  beforeEach(() => {
    db = freshDb();
    trackFlowCreated.mockClear();
  });

  it('saves the file as a new flow that starts turned off, in the project with the same name', async () => {
    const api = await createProject(db, { name: 'api', path: '/b/api' });

    const imported = await caller.importFile({ contents: flowFile(RELEASE) });

    expect(imported).toEqual({ id: expect.any(String), name: 'Release', needsSetup: [] });
    expect(await getFlowById(db, imported.id)).toMatchObject({
      name: 'Release',
      description: 'Ships it',
      projectId: api.id,
      isEnabled: false,
      agentInvocable: false,
    });
    const version = await getLatestVersion(db, imported.id);
    expect(version?.versionNumber).toBe(1);
    expect(version?.graph).toEqual({
      ...RELEASE,
      nodes: [
        RELEASE.nodes[0],
        { ...RELEASE.nodes[1], config: { command: 'make', projectId: api.id } },
      ],
      settings: { defaultProjectId: api.id },
    });
    expect(await listForFlow(db, imported.id)).toEqual([]);
    expect(trackFlowCreated.mock.calls).toEqual([
      [{ id: imported.id, triggerType: 'manual', createdBy: 'import' }],
    ]);
  });

  it('refuses a file that is not a flow and saves nothing', async () => {
    await expect(caller.importFile({ contents: '{"name":"Dusk"}' })).rejects.toThrow(
      "This file isn't a Frink flow.",
    );
    expect(await listFlows(db)).toEqual([]);
    expect(trackFlowCreated).not.toHaveBeenCalled();
  });

  it('refuses a flow the editor could not save', async () => {
    const twoTriggers = {
      ...RELEASE,
      nodes: [...RELEASE.nodes, { id: 't2', blockType: 'manual_trigger' }],
    };

    await expect(caller.importFile({ contents: flowFile(twoTriggers) })).rejects.toThrow(
      "This flow can't be imported:",
    );
    expect(await listFlows(db)).toEqual([]);
  });
});
