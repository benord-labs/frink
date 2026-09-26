import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalChat } from './test-factories';

const {
  pageChatsForProjectsMock,
  countChatsByProjectMock,
  listAllArchivedChatsMock,
  getBatchIdByChatIdMock,
  listChatsByBatchMock,
  listSidebarBatchGroupsMock,
} = vi.hoisted(() => ({
  pageChatsForProjectsMock: vi.fn(),
  countChatsByProjectMock: vi.fn(),
  listAllArchivedChatsMock: vi.fn(),
  getBatchIdByChatIdMock: vi.fn(),
  listChatsByBatchMock: vi.fn(),
  listSidebarBatchGroupsMock: vi.fn(),
}));

vi.mock('../../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../../db/repos/chats', () => ({
  pageChatsForProjects: pageChatsForProjectsMock,
  countChatsByProject: countChatsByProjectMock,
  listAllArchivedChats: listAllArchivedChatsMock,
  // Other procedures in listRouter import these; stub so the module loads.
  listAllChats: vi.fn(),
  listChatsForProject: vi.fn(),
  listPinnedChatsForProjects: vi.fn(),
}));
vi.mock('../../../db/repos/flow-runs', () => ({
  getBatchIdByChatId: getBatchIdByChatIdMock,
  listChatsByBatch: listChatsByBatchMock,
}));
vi.mock('../../../flows/batch-summaries', () => ({
  listSidebarBatchGroups: listSidebarBatchGroupsMock,
}));

import { listRouter } from './list';

// Default: no chat belongs to a batch, so withBatchIds leaves batchId at the mapper's null.
beforeEach(() => getBatchIdByChatIdMock.mockResolvedValue(new Map<string, string>()));

const caller = () => listRouter.createCaller({ getWindow: () => null });

describe('listRouter.listByFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signals hasMore and slices the extra row when the repo returns limit + 1', async () => {
    const rows = [
      makeLocalChat({ id: 'c1', updatedAt: new Date('2026-01-03T00:00:00.000Z') }),
      makeLocalChat({ id: 'c2', updatedAt: new Date('2026-01-02T00:00:00.000Z') }),
      makeLocalChat({ id: 'c3', updatedAt: new Date('2026-01-01T00:00:00.000Z') }),
    ];
    pageChatsForProjectsMock.mockResolvedValue(rows);

    const out = await caller().listByFolder({ projectIds: null, limit: 2 });

    // Router asks the repo for one extra row to detect a further page.
    expect(pageChatsForProjectsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 3 }),
    );
    expect(out.hasMore).toBe(true);
    expect(out.chats).toHaveLength(2);
    expect(out.nextCursor).toEqual({ updatedAt: '2026-01-02T00:00:00.000Z', id: 'c2' });
  });

  it('returns all rows with hasMore false when the repo returns at most limit rows', async () => {
    const rows = [
      makeLocalChat({ id: 'c1', updatedAt: new Date('2026-01-02T00:00:00.000Z') }),
      makeLocalChat({ id: 'c2', updatedAt: new Date('2026-01-01T00:00:00.000Z') }),
    ];
    pageChatsForProjectsMock.mockResolvedValue(rows);

    const out = await caller().listByFolder({ projectIds: null, limit: 2 });

    expect(out.hasMore).toBe(false);
    expect(out.chats).toHaveLength(2);
    expect(out.nextCursor).toEqual({ updatedAt: '2026-01-01T00:00:00.000Z', id: 'c2' });
  });

  it('returns a null cursor for an empty page', async () => {
    pageChatsForProjectsMock.mockResolvedValue([]);

    const out = await caller().listByFolder({ projectIds: null, limit: 30 });

    expect(out.chats).toEqual([]);
    expect(out.hasMore).toBe(false);
    expect(out.nextCursor).toBeNull();
  });

  it('maps null projectIds to the general [null] folder for the repo', async () => {
    pageChatsForProjectsMock.mockResolvedValue([]);

    await caller().listByFolder({ projectIds: null, limit: 30 });

    expect(pageChatsForProjectsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectIds: [null] }),
    );
  });

  it('passes a project-id array through to the repo unchanged', async () => {
    pageChatsForProjectsMock.mockResolvedValue([]);

    await caller().listByFolder({ projectIds: ['p1', 'p2'], limit: 30 });

    expect(pageChatsForProjectsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectIds: ['p1', 'p2'] }),
    );
  });

  it('converts the serialized cursor (ISO string) into a Date before querying', async () => {
    pageChatsForProjectsMock.mockResolvedValue([]);

    await caller().listByFolder({
      projectIds: null,
      limit: 30,
      cursor: { updatedAt: '2026-01-05T00:00:00.000Z', id: 'cursor-id' },
    });

    expect(pageChatsForProjectsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cursor: { updatedAt: new Date('2026-01-05T00:00:00.000Z'), id: 'cursor-id' },
      }),
    );
  });

  it('maps rows through mapLocalChatResponse (batchId injected as null)', async () => {
    pageChatsForProjectsMock.mockResolvedValue([makeLocalChat({ id: 'c1' })]);

    const out = await caller().listByFolder({ projectIds: null, limit: 30 });

    // batchId is added only by the mapper — its presence proves the projection ran.
    expect(out.chats[0]).toMatchObject({ id: 'c1', batchId: null });
  });

  it('attaches batchId from local flow_runs for a chat that belongs to a batch', async () => {
    pageChatsForProjectsMock.mockResolvedValue([
      makeLocalChat({ id: 'c1' }),
      makeLocalChat({ id: 'c2' }),
    ]);
    // c1 is linked to a batch via flow_runs; c2 is not — only c1 should group in the sidebar.
    getBatchIdByChatIdMock.mockResolvedValue(new Map([['c1', 'batch-9']]));

    const out = await caller().listByFolder({ projectIds: null, limit: 30 });

    expect(out.chats.find((c) => c.id === 'c1')?.batchId).toBe('batch-9');
    expect(out.chats.find((c) => c.id === 'c2')?.batchId).toBeNull();
  });
});

describe('listRouter.listBatchGroups', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the local flow_runs batch summaries verbatim', async () => {
    const groups = [{ batch_id: 'b1', flow_name: 'Triage', run_count: 3, completed_count: 1 }];
    listSidebarBatchGroupsMock.mockResolvedValue(groups);

    await expect(caller().listBatchGroups()).resolves.toEqual(groups);
    expect(listSidebarBatchGroupsMock).toHaveBeenCalledTimes(1);
  });
});

describe('listRouter.listByBatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the batch chats locally and stamps each with the requested batchId', async () => {
    const batchId = '11111111-1111-4111-8111-111111111111';
    listChatsByBatchMock.mockResolvedValue([
      makeLocalChat({ id: 'c1' }),
      makeLocalChat({ id: 'c2' }),
    ]);

    const out = await caller().listByBatch({ batchId });

    expect(listChatsByBatchMock).toHaveBeenCalledWith(expect.anything(), batchId);
    expect(out).toMatchObject([
      { id: 'c1', batchId },
      { id: 'c2', batchId },
    ]);
  });
});

describe('listRouter.listCounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the repo per-project counts through unchanged', async () => {
    const counts = [
      { projectId: 'p1', count: 3 },
      { projectId: null, count: 2 },
    ];
    countChatsByProjectMock.mockResolvedValue(counts);

    await expect(caller().listCounts()).resolves.toEqual(counts);
  });
});

describe('listRouter.listArchived', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns every archived chat mapped through the response projection (no project scoping)', async () => {
    // The proc takes no input — it must surface all archived chats globally, not a per-project
    // slice. batchId is injected only by the mapper, so its presence proves the projection ran.
    listAllArchivedChatsMock.mockResolvedValue([
      makeLocalChat({ id: 'arch-owned', projectId: 'p1' }),
      makeLocalChat({ id: 'arch-general', projectId: null }),
    ]);

    const out = await caller().listArchived();

    expect(listAllArchivedChatsMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject([
      { id: 'arch-owned', batchId: null },
      { id: 'arch-general', batchId: null },
    ]);
  });

  it('returns an empty array when nothing is archived', async () => {
    listAllArchivedChatsMock.mockResolvedValue([]);

    await expect(caller().listArchived()).resolves.toEqual([]);
  });
});
